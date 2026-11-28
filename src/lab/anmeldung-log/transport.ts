// How the wallet reaches a service: GET and POST with a size cap, a time
// limit, no redirect followed, and no connection into the local network.
//
// Two layers:
// - `limited(send)`: the rules every fetch keeps (https URL without
//   credentials and without an IP address as host, size cap, time limit over
//   the whole exchange, no redirect);
// - `httpsSend`: the one way to send in this module, `node:https` with its own
//   `lookup`. Not the name decides but the address the socket connects to:
//   the lookup resolves the name once, refuses if any address it got lies in
//   a local range (`localAddress`), and hands exactly these addresses to the
//   socket, so nothing resolves the name a second time.
// `httpsTransport()` is the two together and the wallet's default. A test
// builds its own `send` (tests/anmeldung-log-loopback.ts); nothing here
// fetches over plain http or from 127.0.0.1.

import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'

export const LIMITS = { requestBytes: 16 * 1024, logBytes: 256 * 1024, replyBytes: 16 * 1024, timeoutMs: 5000 }

export type Fetched = { status: number, type: string, text: string }
export interface FetchRequest { method?: 'GET' | 'POST', body?: string, maxBytes: number, accept?: string }
/** What the wallet uses to fetch: the result, or why not. */
export interface Transport { fetch (url: string, o: FetchRequest): Promise<Fetched | { error: string }> }

/** One raw exchange: the response head and its body, or a thrown error (its `code` LOCAL_ADDRESS for a refused address). */
export type Send = (url: URL, o: { method: 'GET' | 'POST', headers: Record<string, string>, body?: string, signal: AbortSignal }) =>
  Promise<{ status: number, type: string, body: AsyncIterable<Uint8Array> }>
export const LOCAL_ADDRESS = 'LOCAL_ADDRESS'

/** The rules every fetch keeps, around one way to send. */
export function limited (send: Send, o: { timeoutMs?: number } = {}): Transport {
  return {
    async fetch (url, r) {
      let u: URL
      try { u = new URL(url) } catch { return { error: 'not a URL' } }
      if (u.protocol !== 'https:') return { error: 'not https' }
      if (u.username || u.password) return { error: 'credentials in the URL' }
      const host = u.hostname.toLowerCase()
      // an IP address as host is never looked up, so it is refused here (did:webvh 1.0 refuses it in the DID too)
      if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 || /^[0-9.]+$|^0x/i.test(host)) return { error: 'a local address' }
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), o.timeoutMs ?? LIMITS.timeoutMs)
      try {
        const res = await send(u, {
          method: r.method ?? 'GET',
          headers: { ...(r.body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(r.accept ? { Accept: r.accept } : {}) },
          ...(r.body !== undefined ? { body: r.body } : {}),
          signal: abort.signal,
        })
        if (res.status >= 300 && res.status < 400) return { error: 'a redirect (not followed)' }
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const c of res.body) {
          size += c.length
          if (size > r.maxBytes) { abort.abort(); return { error: 'too large' } }
          chunks.push(c)
        }
        const bytes = new Uint8Array(size); let at = 0
        for (const c of chunks) { bytes.set(c, at); at += c.length }
        return { status: res.status, type: res.type, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) }
      } catch (e) {
        if ((e as { code?: string })?.code === LOCAL_ADDRESS) return { error: 'a local address' }
        return { error: abort.signal.aborted ? 'timeout' : 'unreachable' }
      } finally { clearTimeout(timer) }
    },
  }
}

/** A name to its addresses (the default is the system's resolver). */
export type Resolve = (host: string) => Promise<{ address: string, family: number }[]>
const systemResolve: Resolve = (host) => dnsLookup(host, { all: true, verbatim: true })

/** `node:https` with a lookup that refuses a local address and passes on exactly what it checked. */
export function httpsSend (o: { resolve?: Resolve } = {}): Send {
  const resolve = o.resolve ?? systemResolve
  const lookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname).then((all) => {
      if (all.length === 0) { callback(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '', 4); return }
      // refused if any address is local: a name that answers with a local and a public address is not used
      if (all.some((a) => localAddress(a.address))) { callback(Object.assign(new Error('a local address'), { code: LOCAL_ADDRESS }), '', 4); return }
      const want = all.filter((a) => !options.family || a.family === options.family)
      if (want.length === 0) { callback(Object.assign(new Error('no address of this family'), { code: 'ENOTFOUND' }), '', 4); return }
      if (options.all) (callback as unknown as (e: null, a: { address: string, family: number }[]) => void)(null, want)
      else callback(null, (want[0] as { address: string }).address, (want[0] as { family: number }).family)
    }, (e) => callback(e as NodeJS.ErrnoException, '', 4))
  }
  return (url, r) => new Promise((ok, fail) => {
    const req = httpsRequest(url, { method: r.method, headers: r.headers, lookup, agent: false, signal: r.signal }, (res) => {
      ok({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: res })
    })
    req.on('error', fail)
    req.end(r.body)
  })
}

/** The wallet's default transport. */
export const httpsTransport = (o: { resolve?: Resolve, timeoutMs?: number } = {}): Transport => limited(httpsSend(o), o)

const v4 = (s: string): number[] | null => {
  const p = s.split('.')
  if (p.length !== 4 || !p.every((x) => /^[0-9]{1,3}$/.test(x) && Number(x) <= 255)) return null
  return p.map(Number)
}
function v6 (s: string): number[] | null {
  // 16 bytes of an IPv6 address, also with an IPv4 tail (::ffff:10.0.0.1)
  let text = s.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const dotted = /^(.*:)([0-9]+\.[0-9.]+)$/.exec(text)
  if (dotted) {
    // the IPv4 tail as the last two groups
    const four = v4(dotted[2] as string)
    if (!four) return null
    text = `${dotted[1]}${((four[0]! << 8) | four[1]!).toString(16)}:${((four[2]! << 8) | four[3]!).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groups = (h: string): string[] => h === '' ? [] : h.split(':')
  const head = groups(halves[0] as string), rest = halves.length === 2 ? groups(halves[1] as string) : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const all = [...head, ...Array(fill).fill('0'), ...rest]
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  const bytes: number[] = []
  for (const g of all) { const n = parseInt(g, 16); bytes.push(n >> 8, n & 255) }
  return bytes
}

/**
 * An address in a range the wallet does not connect to: private,
 * loopback, link-local, carrier-grade NAT, multicast, unspecified (IPv4 and
 * IPv6), and IPv4 inside IPv6 (mapped, compatible, NAT64) by the IPv4 rule.
 * Anything that is not an address counts as local.
 */
export function localAddress (address: string): boolean {
  const a = v4(address)
  if (a) {
    const [x, y] = a as [number, number]
    return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || x >= 224
  }
  const b = v6(address)
  if (!b) return true
  const zero = (from: number, to: number): boolean => b.slice(from, to).every((v) => v === 0)
  const embedded = b.slice(12).join('.')
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return localAddress(embedded)            // ::ffff:a.b.c.d
  if (zero(0, 12)) return localAddress(embedded)                                                // ::, ::1 (as 0.0.0.x) and ::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return localAddress(embedded)  // 64:ff9b::/96
  const first = b[0] as number, second = b[1] as number
  return (first & 0xfe) === 0xfc ||                       // fc00::/7 unique local
    (first === 0xfe && (second & 0xc0) === 0x80) ||       // fe80::/10 link-local
    (first === 0xfe && (second & 0xc0) === 0xc0) ||       // fec0::/10 site-local (deprecated)
    first === 0xff                                         // ff00::/8 multicast
}
