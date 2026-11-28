// The three names under discussion, as settings of log.ts. Which one a
// login identifier takes is open (didwebvh#305); nothing else in this
// directory depends on the choice.
import type { Profile } from './log'

const COMMON = ['method', 'scid', 'updateKeys', 'nextKeyHashes', 'witness', 'watchers', 'deactivated', 'ttl'] as const

const PCT_OK = /^(?:[^%]|%[0-9A-Fa-f]{2})*$/
const decodeOnce = (s: string): string | null => { try { return decodeURIComponent(s) } catch { return null } }
const octets = (s: string): number => new TextEncoder().encode(s).length

/**
 * did:webvh 1.0, Method-Specific Identifier: `scid ":" webvh-domain
 * *( ":" webvh-path-segment )`, with the rules stated beside the ABNF.
 * Not done: IDNA processing (a label that decodes to non-ASCII is
 * unsupported here) and the TLS server identity check of RFC 9525.
 */
export function webvhSyntax (id: string): { kind: 'invalid' | 'unsupported', reason: string } | null {
  const bad = (reason: string) => ({ kind: 'invalid' as const, reason })
  if (!id.startsWith('did:webvh:')) return bad('not did:webvh')
  const [scid, domain, ...segments] = id.slice('did:webvh:'.length).split(':')
  if (!scid || !/^[1-9A-HJ-NP-Za-km-z]{46}$/.test(scid)) return bad('the scid is not 46 base58btc characters')
  // webvh-domain = encoded-domain-name [ "%3A" port-number ]
  const m = /^(.*?)(?:%3[Aa]([0-9]{1,5}))?$/.exec(domain ?? '') as RegExpExecArray
  const name = m[1] as string
  if (m[2] !== undefined && !(Number(m[2]) >= 1 && Number(m[2]) <= 65535)) return bad('the port is not in 1 to 65535')
  if (/%3[Aa]/.test(name)) return bad('a percent-encoded colon within the domain name')
  const labels = name.split('.')
  if (labels.length < 2) return bad('the domain is not a dotted name')
  if (labels.some((l) => !/^(?:[A-Za-z0-9-]|%[0-9A-Fa-f]{2})+$/.test(l))) return bad('a domain label is empty or has other characters')
  const decoded = decodeOnce(name)
  if (decoded === null) return bad('invalid percent-encoding in the domain')
  // an ASCII character that no host name has is invalid, whatever else the name holds; IDNA only concerns non-ASCII
  if (/[\x00-\x2c\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]/.test(decoded)) return bad('the domain has a character that a host name cannot have')
  if (/[^\x00-\x7f]/.test(decoded)) return { kind: 'unsupported', reason: 'a domain that needs IDNA processing is not supported here' }
  const dl = decoded.split('.')
  if (dl.some((l) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(l) || octets(l) > 63) || octets(decoded) > 253) return bad('the domain is not a host name (RFC 1123)')
  // an IP address: a URL parser takes a host whose last label is a number as IPv4
  if (/^(?:[0-9]+|0[xX][0-9A-Fa-f]*)$/.test(dl[dl.length - 1] as string)) return bad('the domain is an IP address')
  for (const s of segments) {
    if (!/^(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+$/.test(s) || !PCT_OK.test(s)) return bad('a path segment is empty or has other characters')
    const d = decodeOnce(s)
    if (d === null) return bad('invalid percent-encoding in a path segment')
    if (d === '.' || d === '..' || /[/\\\u0000]/.test(d) || d.trim() !== d) return bad('a path segment is not allowed')
  }
  return null
}

/** did:webvh 1.0, with a host (and optional path segments, already encoded). */
export const webvh = (host: string): Profile => ({
  did: `did:webvh:{SCID}:${host}`,
  method: 'did:webvh:1.0',
  parameters: [...COMMON, 'portable'],
  family: 'webvh',
  syntax: webvhSyntax,
})

/** did:vh (editor's draft): no host, `method` `did:vh:1.0`, no `portable`. */
export const vh: Profile = {
  did: 'did:vh:{SCID}',
  method: 'did:vh:1.0',
  parameters: COMMON,
  family: 'vh',
}

/**
 * did:scid:vh:1 with the did:vh log format. No text defines this case: the
 * did:vh draft says in its note "Future use by did:scid:vh" that the `id`
 * would then be the did:scid:vh DID "while the rest of the DID Log is
 * created and verified as defined here". `method` `did:vh:1.0` is an
 * assumption of this experiment, not a specified value, and says nothing
 * about what interoperates today.
 */
export const scidVh: Profile = {
  did: 'did:scid:vh:1:{SCID}',
  method: 'did:vh:1.0',
  parameters: COMMON,
  family: 'vh',
}
