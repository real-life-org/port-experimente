// How the wallet reaches a service: GET and POST with a size cap, a time
// limit, no redirect followed, and a connection only to addresses that are
// globally reachable.
//
// Two layers:
// - `limited(send)`: the rules every exchange keeps (https URL without
//   credentials and without an IP address as host, size cap, time limit over
//   the whole exchange: at the deadline the exchange returns `timeout`, also
//   when the way to send does not heed the abort signal; no redirect: a 3xx is
//   aborted and its socket closed before the answer is returned);
// - `httpsSend`: the one way to send in this module, `node:https` with its own
//   `lookup`. Not the name decides but the address the socket connects to:
//   the lookup resolves the name once, refuses unless every address it got is
//   globally reachable (`globallyReachable`), and hands exactly these addresses
//   to the socket, so nothing resolves the name a second time.
// `httpsTransport()` is the two together and the wallet's default. A test
// builds its own `send` (tests/anmeldung-log-loopback.ts); nothing here
// fetches over plain http or from 127.0.0.1.

import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'

export const LIMITS = { requestBytes: 16 * 1024, logBytes: 256 * 1024, replyBytes: 16 * 1024, timeoutMs: 5000 }

export type Fetched = { status: number, type: string, text: string }
/** What the wallet uses: GET to read (the service log, the Request Object), POST to send (the answer). The result, or why not. */
export interface Transport {
  get (url: string, o: { maxBytes: number, accept?: string }): Promise<Fetched | { error: string }>
  post (url: string, body: string, o: { maxBytes: number }): Promise<Fetched | { error: string }>
}

/** One raw exchange: the response head and its body, or a thrown error (its `code` LOCAL_ADDRESS for a refused address). */
export type Send = (url: URL, o: { method: 'GET' | 'POST', headers: Record<string, string>, body?: string, signal: AbortSignal }) =>
  Promise<{ status: number, type: string, body: AsyncIterable<Uint8Array> }>
export const LOCAL_ADDRESS = 'LOCAL_ADDRESS'

/** The rules every exchange keeps, around one way to send. */
export function limited (send: Send, o: { timeoutMs?: number } = {}): Transport {
  const exchange = async (url: string, method: 'GET' | 'POST', maxBytes: number, body?: string, accept?: string): Promise<Fetched | { error: string }> => {
    let u: URL
    try { u = new URL(url) } catch { return { error: 'not a URL' } }
    if (u.protocol !== 'https:') return { error: 'not https' }
    if (u.username || u.password) return { error: 'credentials in the URL' }
    // an IP address as host is never looked up, so it is refused here (did:webvh 1.0 refuses it in the DID too). The URL
    // parser has already turned every IPv4 form it reads as an address (0x7f000001, 127.1, octal) into dotted decimal and
    // put IPv6 in brackets; a DNS name, also one that begins with 0x, stays a name.
    if (isIP(u.hostname.replace(/^\[|\]$/g, '')) !== 0) return { error: 'a local address' }
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    // the deadline settles the exchange itself; aborting the signal also lets a way to send that heeds it close its connection
    const deadline = new Promise<{ error: string }>((settle) => { timer = setTimeout(() => { abort.abort(); settle({ error: 'timeout' }) }, o.timeoutMs ?? LIMITS.timeoutMs) })
    const work = async (): Promise<Fetched | { error: string }> => {
      try {
        const res = await send(u, {
          method,
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(accept ? { Accept: accept } : {}) },
          ...(body !== undefined ? { body } : {}),
          signal: abort.signal,
        })
        // not followed, and not left open: the exchange is aborted, which closes the socket
        if (res.status >= 300 && res.status < 400) { abort.abort(); return { error: 'a redirect (not followed)' } }
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const c of res.body) {
          size += c.length
          if (size > maxBytes) { abort.abort(); return { error: 'too large' } }
          chunks.push(c)
        }
        const bytes = new Uint8Array(size); let at = 0
        for (const c of chunks) { bytes.set(c, at); at += c.length }
        return { status: res.status, type: res.type, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) }
      } catch (e) {
        if ((e as { code?: string })?.code === LOCAL_ADDRESS) return { error: 'a local address' }
        return { error: abort.signal.aborted ? 'timeout' : 'unreachable' }
      }
    }
    try { return await Promise.race([work(), deadline]) } finally { clearTimeout(timer) }
  }
  return {
    get: (url, r) => exchange(url, 'GET', r.maxBytes, undefined, r.accept),
    post: (url, body, r) => exchange(url, 'POST', r.maxBytes, body),
  }
}

/** A name to its addresses (the default is the system's resolver). */
export type Resolve = (host: string) => Promise<{ address: string, family: number }[]>
const systemResolve: Resolve = (host) => dnsLookup(host, { all: true, verbatim: true })

/** `node:https` with a lookup that refuses any address that is not globally reachable and passes on exactly what it checked. */
export function httpsSend (o: { resolve?: Resolve } = {}): Send {
  const resolve = o.resolve ?? systemResolve
  const lookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname).then((all) => {
      if (all.length === 0) { callback(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '', 4); return }
      // refused unless every address is globally reachable: a name that answers with a local and a public address is not used
      if (!all.every((a) => globallyReachable(a.address))) { callback(Object.assign(new Error('a local address'), { code: LOCAL_ADDRESS }), '', 4); return }
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


// ---- which addresses the wallet connects to
//
// Only addresses that are globally reachable after the two IANA registers
// below. The rows are the registers' rows with their "Globally Reachable"
// value as written there ("True", "False", "N/A", or empty for a
// deprecated row). Where rows nest, the most specific row decides (the
// registers' footnotes: "Not useable unless by virtue of a more specific
// reservation", "Unless allowed by a more specific allocation").

export type RegisterRow = readonly [block: string, name: string, rfc: string, globallyReachable: 'True' | 'False' | 'N/A' | '']

/**
 * IANA IPv4 Special-Purpose Address Registry,
 * https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml
 * (last updated 2025-10-09, read 2026-11-28). The row with two blocks
 * (192.0.0.170/32, 192.0.0.171/32) is written as two rows.
 */
export const IPV4_SPECIAL: readonly RegisterRow[] = [
  ['0.0.0.0/8', '"This network"', 'RFC 791, Section 3.2', 'False'],
  ['0.0.0.0/32', '"This host on this network"', 'RFC 1122, Section 3.2.1.3', 'False'],
  ['10.0.0.0/8', 'Private-Use', 'RFC 1918', 'False'],
  ['100.64.0.0/10', 'Shared Address Space', 'RFC 6598', 'False'],
  ['127.0.0.0/8', 'Loopback', 'RFC 1122, Section 3.2.1.3', 'False'],
  ['169.254.0.0/16', 'Link Local', 'RFC 3927', 'False'],
  ['172.16.0.0/12', 'Private-Use', 'RFC 1918', 'False'],
  ['192.0.0.0/24', 'IETF Protocol Assignments', 'RFC 6890, Section 2.1', 'False'],
  ['192.0.0.0/29', 'IPv4 Service Continuity Prefix', 'RFC 7335', 'False'],
  ['192.0.0.8/32', 'IPv4 dummy address', 'RFC 7600', 'False'],
  ['192.0.0.9/32', 'Port Control Protocol Anycast', 'RFC 7723', 'True'],
  ['192.0.0.10/32', 'Traversal Using Relays around NAT Anycast', 'RFC 8155', 'True'],
  ['192.0.0.170/32', 'NAT64/DNS64 Discovery', 'RFC 8880; RFC 7050, Section 2.2', 'False'],
  ['192.0.0.171/32', 'NAT64/DNS64 Discovery', 'RFC 8880; RFC 7050, Section 2.2', 'False'],
  ['192.0.2.0/24', 'Documentation (TEST-NET-1)', 'RFC 5737', 'False'],
  ['192.31.196.0/24', 'AS112-v4', 'RFC 7535', 'True'],
  ['192.52.193.0/24', 'AMT', 'RFC 7450', 'True'],
  ['192.88.99.0/24', 'Deprecated (6to4 Relay Anycast)', 'RFC 7526', ''],
  ['192.88.99.2/32', '6a44-relay anycast address', 'RFC 6751', 'False'],
  ['192.168.0.0/16', 'Private-Use', 'RFC 1918', 'False'],
  ['192.175.48.0/24', 'Direct Delegation AS112 Service', 'RFC 7534', 'True'],
  ['198.18.0.0/15', 'Benchmarking', 'RFC 2544', 'False'],
  ['198.51.100.0/24', 'Documentation (TEST-NET-2)', 'RFC 5737', 'False'],
  ['203.0.113.0/24', 'Documentation (TEST-NET-3)', 'RFC 5737', 'False'],
  ['240.0.0.0/4', 'Reserved', 'RFC 1112, Section 4', 'False'],
  ['255.255.255.255/32', 'Limited Broadcast', 'RFC 8190; RFC 919, Section 7', 'False'],
]

/**
 * IANA IPv6 Special-Purpose Address Registry,
 * https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml
 * (last updated 2025-10-09, read 2026-11-28).
 */
export const IPV6_SPECIAL: readonly RegisterRow[] = [
  ['::1/128', 'Loopback Address', 'RFC 4291', 'False'],
  ['::/128', 'Unspecified Address', 'RFC 4291', 'False'],
  ['::ffff:0:0/96', 'IPv4-mapped Address', 'RFC 4291', 'False'],
  ['64:ff9b::/96', 'IPv4-IPv6 Translat.', 'RFC 6052', 'True'],
  ['64:ff9b:1::/48', 'IPv4-IPv6 Translat.', 'RFC 8215', 'False'],
  ['100::/64', 'Discard-Only Address Block', 'RFC 6666', 'False'],
  ['100:0:0:1::/64', 'Dummy IPv6 Prefix', 'RFC 9780', 'False'],
  ['2001::/23', 'IETF Protocol Assignments', 'RFC 2928', 'False'],
  ['2001::/32', 'TEREDO', 'RFC 4380; RFC 8190', 'N/A'],
  ['2001:1::1/128', 'Port Control Protocol Anycast', 'RFC 7723', 'True'],
  ['2001:1::2/128', 'Traversal Using Relays around NAT Anycast', 'RFC 8155', 'True'],
  ['2001:1::3/128', 'DNS-SD Service Registration Protocol Anycast', 'RFC 9665', 'True'],
  ['2001:2::/48', 'Benchmarking', 'RFC 5180; RFC Errata 1752', 'False'],
  ['2001:3::/32', 'AMT', 'RFC 7450', 'True'],
  ['2001:4:112::/48', 'AS112-v6', 'RFC 7535', 'True'],
  ['2001:10::/28', 'Deprecated (previously ORCHID)', 'RFC 4843', ''],
  ['2001:20::/28', 'ORCHIDv2', 'RFC 7343', 'True'],
  ['2001:30::/28', 'Drone Remote ID Protocol Entity Tags (DETs) Prefix', 'RFC 9374', 'True'],
  ['2001:db8::/32', 'Documentation', 'RFC 3849', 'False'],
  ['2002::/16', '6to4', 'RFC 3056', 'N/A'],
  ['2620:4f:8000::/48', 'Direct Delegation AS112 Service', 'RFC 7534', 'True'],
  ['3fff::/20', 'Documentation', 'RFC 9637', 'False'],
  ['5f00::/16', 'Segment Routing (SRv6) SIDs', 'RFC 9602', 'False'],
  ['fc00::/7', 'Unique-Local', 'RFC 4193; RFC 8190', 'False'],
  ['fe80::/10', 'Link-Local Unicast', 'RFC 4291', 'False'],
]

/** The 4 bytes of a dotted IPv4 address, or null. */
export function v4 (s: string): number[] | null {
  const p = s.split('.')
  if (p.length !== 4 || !p.every((x) => /^(0|[1-9][0-9]{0,2})$/.test(x) && Number(x) <= 255)) return null
  return p.map(Number)
}
/** The 16 bytes of an IPv6 address (also with an IPv4 tail, `::ffff:10.0.0.1`), or null. A zone (`%eth0`) is refused. */
export function v6 (s: string): number[] | null {
  let text = s.toLowerCase()
  if (text.includes('%')) return null
  const dotted = /^(.*:)([0-9]+\.[0-9.]+)$/.exec(text)
  if (dotted) {
    const four = v4(dotted[2] as string)
    if (!four) return null
    text = `${dotted[1]}${((four[0]! << 8) | four[1]!).toString(16)}:${((four[2]! << 8) | four[3]!).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groups = (h: string): string[] => h === '' ? [] : h.split(':')
  const head = groups(halves[0] as string), rest = halves.length === 2 ? groups(halves[1] as string) : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if ((halves.length === 2 && fill < 1) || (halves.length === 1 && head.length !== 8)) return null
  const all = [...head, ...Array(fill).fill('0'), ...rest]
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  const bytes: number[] = []
  for (const g of all) { const n = parseInt(g, 16); bytes.push(n >> 8, n & 255) }
  return bytes
}

/** Does `bytes` lie in the block `prefix/len` (prefix as bytes)? */
function within (bytes: number[], prefix: number[], len: number): boolean {
  for (let bit = 0; bit < len; bit++) {
    const i = bit >> 3, m = 0x80 >> (bit & 7)
    if (((bytes[i] as number) & m) !== ((prefix[i] as number) & m)) return false
  }
  return true
}
type Block = { bytes: number[], len: number, row: RegisterRow }
function blocks (rows: readonly RegisterRow[], parse: (s: string) => number[] | null): Block[] {
  return rows.map((row) => {
    const [a, l] = row[0].split('/') as [string, string]
    const bytes = parse(a)
    if (!bytes) throw new Error(`register row ${row[0]} does not parse`)
    return { bytes, len: Number(l), row }
  })
}
const V4_BLOCKS = blocks(IPV4_SPECIAL, v4), V6_BLOCKS = blocks(IPV6_SPECIAL, v6)

/** The most specific register row an address lies in, or null. */
export function registerRow (address: string): RegisterRow | null {
  const a = v4(address), b = a ? null : v6(address)
  const bytes = a ?? b
  if (!bytes) return null
  let best: Block | null = null
  for (const k of a ? V4_BLOCKS : V6_BLOCKS) if (within(bytes, k.bytes, k.len) && (!best || k.len > best.len)) best = k
  return best?.row ?? null
}

const in4 = (a: number[], block: string): boolean => { const [p, l] = block.split('/') as [string, string]; return within(a, v4(p)!, Number(l)) }
const in6 = (b: number[], block: string): boolean => { const [p, l] = block.split('/') as [string, string]; return within(b, v6(p)!, Number(l)) }

/**
 * May the wallet connect to this address? Anything that is not an address is not.
 *
 * IPv4: not multicast (224.0.0.0/4) and not class E (240.0.0.0/4, also a
 * register row); otherwise the most specific row of the IPv4 register
 * decides, and only "True" allows. An address in no row is allowed.
 *
 * IPv6: only 2000::/3, the one block marked "Global Unicast" in the IANA
 * Internet Protocol Version 6 Address Space registry
 * (https://www.iana.org/assignments/ipv6-address-space/, read 2026-11-28),
 * with one exception outside it: the Well-Known Prefix 64:ff9b::/96 (register "True") is
 * judged by the IPv4 address in its last 32 bits (RFC 6052 2.2; RFC 6052
 * 3.1: it MUST NOT represent a non-global IPv4 address). Everything else
 * outside 2000::/3 is refused, among it ::1, ::, IPv4-mapped ::ffff:0:0/96
 * (register "False"), 64:ff9b:1::/48 (register "False"), fc00::/7, fe80::/10,
 * ff00::/8. Inside 2000::/3: 6to4 2002::/16 (register "N/A", "See RFC
 * 3056") is judged by its embedded IPv4 address, bits 16 to 47 (RFC 3056
 * 2, 2002:V4ADDR::/48); Teredo 2001::/32 (register "N/A") is refused: its
 * client address is obfuscated and reached through a relay (RFC 4380 4);
 * otherwise the most specific row decides, and only "True" allows. An
 * address in no row is allowed.
 */
export function globallyReachable (address: string): boolean {
  const a = v4(address)
  if (a) {
    if (in4(a, '224.0.0.0/4') || in4(a, '240.0.0.0/4')) return false
    const row = registerRow(address)
    return row === null || row[3] === 'True'
  }
  const b = v6(address)
  if (!b) return false
  if (in6(b, '64:ff9b::/96')) return globallyReachable(b.slice(12).join('.'))
  if (!in6(b, '2000::/3')) return false
  if (in6(b, '2002::/16')) return globallyReachable(b.slice(2, 6).join('.'))
  if (in6(b, '2001::/32')) return false
  const row = registerRow(address)
  return row === null || row[3] === 'True'
}
