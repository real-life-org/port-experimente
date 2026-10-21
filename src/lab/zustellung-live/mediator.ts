// The mediator's DID document (draft 3 §3.3, review 3 C2/C5/C6): one resolved
// document feeds the ATM login (injected resolver, also into every login), the
// socket endpoint and the routing layer's key. The summary keeps only
// validated fragments or local labels, key fingerprints and hosts.

import { multibase, parseMediatorEndpoints } from '@openvtc/vti-didcomm-js'
import { sha256hex, short8 } from './util'

export const METHOD_TYPES = ['Multikey', 'Ed25519VerificationKey2020', 'X25519KeyAgreementKey2020', 'JsonWebKey2020', 'other'] as const
export const SERVICE_TYPES = ['DIDCommMessaging', 'Authentication', 'TSPTransport', 'other'] as const
export const PRIME_NOTES = ['measured', 'no-tsp-service', 'no-own-target', 'same-as-default', 'non-webvh-target', 'target-unresolved', 'target-no-x25519'] as const
export type PrimeNote = (typeof PRIME_NOTES)[number]

export interface MethodSummary {
  ref: string
  type: (typeof METHOD_TYPES)[number]
  keyKind: 'ed25519' | 'x25519' | 'other'
  fingerprint: string
  keyAgreement: boolean
  authentication: boolean
  assertionMethod: boolean
}

export interface ServiceSummary {
  ref: string
  type: (typeof SERVICE_TYPES)[number]
  hosts: string[]
}

/** One routing target (review 3 C2): first-hop VID, method, X25519 key, source document version. Separate from the ATM identity. */
export interface RoutingVariant {
  firstHopVid: string
  methodRef: string
  x25519: Uint8Array
  sourceDocVersion: string
}

export interface MediatorInfo {
  did: string
  versionId: string
  wsHost: string
  services: ServiceSummary[]
  methods: MethodSummary[]
  /** Ed25519 keys of the mediator in document order (candidates for its control frames). */
  edCandidates: Array<{ ref: string; pub: Uint8Array }>
  routing: RoutingVariant
  prime: RoutingVariant | null
  primeNote: PrimeNote
  /** Resolver handed to `resolveMediator` and every `authenticateToMediator`: it knows exactly this document. */
  resolver: (did: string) => Promise<{ didDocument: object }>
}

const FRAGMENT = /^(key-\d{1,3}|keys-\d{1,3}|service|tsp|auth|files|whois)$/
const VERSION_ID = /^(\d{1,6})-([1-9A-HJ-NP-Za-km-z]{8,64})$/
const HOST = /^[a-z0-9.-]{1,253}$/

/** A method or service id as shown: a known fragment, else a local label. */
export function fragmentLabel(id: unknown, index: number, prefix: 'm' | 's'): string {
  if (typeof id === 'string') {
    const frag = id.includes('#') ? id.slice(id.lastIndexOf('#') + 1) : ''
    if (FRAGMENT.test(frag)) return frag
  }
  return `${prefix}${index}`
}

/** `versionId` as shown: `<n>-<first 8 of the hash>` after a format check, else `invalid`. */
export function versionLabel(v: unknown): string {
  if (typeof v !== 'string') return 'invalid'
  const m = VERSION_ID.exec(v)
  return m ? `${m[1]}-${m[2]!.slice(0, 8)}` : 'invalid'
}

/** Host of a URL only (never path, query or fragment); `invalid` if it does not parse or fails the format. */
export function hostOf(u: unknown): string {
  if (typeof u !== 'string') return 'invalid'
  try {
    const h = new URL(u).hostname
    return HOST.test(h) ? h : 'invalid'
  } catch {
    return 'invalid'
  }
}

interface RawMethod {
  id?: unknown
  type?: unknown
  publicKeyMultibase?: unknown
}

function keyOf(m: RawMethod): { kind: 'ed25519' | 'x25519' | 'other'; key: Uint8Array | null } {
  if (typeof m.publicKeyMultibase !== 'string') return { kind: 'other', key: null }
  try {
    const { codec, key } = multibase.decodeMultikey(m.publicKeyMultibase)
    if (codec[0] === 0xed && codec[1] === 0x01) return { kind: 'ed25519', key }
    if (codec[0] === 0xec && codec[1] === 0x01) return { kind: 'x25519', key }
  } catch {
    /* not a multikey */
  }
  return { kind: 'other', key: null }
}

function refsOf(doc: Record<string, unknown>, rel: string): Array<string | RawMethod> {
  const v = doc[rel]
  return Array.isArray(v) ? (v as Array<string | RawMethod>) : []
}

function absolute(ref: string, did: string): string {
  return ref.startsWith('#') ? did + ref : ref
}

/** All methods of the document: declared ones plus inline relation entries, in document order. */
function methodsOf(doc: Record<string, unknown>, did: string): Array<RawMethod & { absId: string }> {
  const out: Array<RawMethod & { absId: string }> = []
  const vms = Array.isArray(doc.verificationMethod) ? (doc.verificationMethod as RawMethod[]) : []
  for (const vm of vms) out.push({ ...vm, absId: absolute(String(vm.id ?? ''), did) })
  for (const rel of ['keyAgreement', 'authentication', 'assertionMethod']) {
    for (const r of refsOf(doc, rel)) if (typeof r === 'object' && r !== null) out.push({ ...r, absId: absolute(String(r.id ?? ''), did) })
  }
  return out
}

function relationIds(doc: Record<string, unknown>, rel: string, did: string): Set<string> {
  return new Set(refsOf(doc, rel).map((r) => absolute(typeof r === 'string' ? r : String(r.id ?? ''), did)))
}

function firstKeyAgreement(doc: Record<string, unknown>, did: string, methods: Array<RawMethod & { absId: string }>): (RawMethod & { absId: string }) | undefined {
  const r = refsOf(doc, 'keyAgreement')[0]
  if (r === undefined) return undefined
  const id = absolute(typeof r === 'string' ? r : String(r.id ?? ''), did)
  return methods.find((m) => m.absId === id)
}

function endpointsOf(s: Record<string, unknown>): string[] {
  const se = s.serviceEndpoint
  const list = Array.isArray(se) ? se : [se]
  return list.map((e) => (typeof e === 'string' ? e : typeof e === 'object' && e !== null ? (e as { uri?: unknown }).uri : undefined)).filter((u): u is string => typeof u === 'string')
}

function serviceType(t: unknown): (typeof SERVICE_TYPES)[number] {
  const list = Array.isArray(t) ? t : [t]
  for (const known of SERVICE_TYPES) if (known !== 'other' && list.includes(known)) return known
  return 'other'
}

export interface ResolvedDoc {
  didDocument: Record<string, unknown>
  didDocumentMetadata: Record<string, unknown>
}

/**
 * Summarize the mediator document and fix the routing variants.
 * `resolveWebvh` resolves a TSPTransport target of method did:webvh (R-c'); other methods are not measured (C2).
 */
export async function summarizeMediator(did: string, resolved: ResolvedDoc, resolveWebvh: (did: string) => Promise<ResolvedDoc>, netPolicy?: object): Promise<MediatorInfo> {
  const doc = resolved.didDocument
  const versionId = versionLabel(resolved.didDocumentMetadata?.versionId)
  const resolver = async (d: string) => {
    if (d !== did) throw new Error('e11b resolver: unknown DID')
    return { didDocument: doc as object }
  }
  // Same parser as the ATM login: wsEndpoint and key agreement from one document version.
  const parsed = parseMediatorEndpoints(doc, did, netPolicy ? { netPolicy } : {})
  const methods = methodsOf(doc, did)
  const ka = relationIds(doc, 'keyAgreement', did)
  const au = relationIds(doc, 'authentication', did)
  const am = relationIds(doc, 'assertionMethod', did)
  const seen = new Set<string>()
  const summaries: MethodSummary[] = []
  const edCandidates: Array<{ ref: string; pub: Uint8Array }> = []
  methods.forEach((m, i) => {
    if (seen.has(m.absId)) return
    seen.add(m.absId)
    const { kind, key } = keyOf(m)
    const ref = fragmentLabel(m.absId, i, 'm')
    const type = (METHOD_TYPES as readonly string[]).includes(String(m.type)) ? (m.type as MethodSummary['type']) : 'other'
    summaries.push({ ref, type, keyKind: kind, fingerprint: key ? short8(sha256hex(key)) : '00000000', keyAgreement: ka.has(m.absId), authentication: au.has(m.absId), assertionMethod: am.has(m.absId) })
    if (kind === 'ed25519' && key) edCandidates.push({ ref, pub: key })
  })
  const kaFirst = firstKeyAgreement(doc, did, methods)
  const kaKey = kaFirst ? keyOf(kaFirst) : { kind: 'other' as const, key: null }
  if (!kaFirst || kaKey.kind !== 'x25519' || !kaKey.key) throw new Error('e11b: mediator has no X25519 keyAgreement')
  // The login takes ka[0] too; both must be the same key.
  if (sha256hex(parsed.x25519Pub) !== sha256hex(kaKey.key)) throw new Error('e11b: login key differs from routing key')
  const routing: RoutingVariant = { firstHopVid: did, methodRef: fragmentLabel(kaFirst.absId, methods.indexOf(kaFirst), 'm'), x25519: kaKey.key, sourceDocVersion: versionId }

  const rawServices = Array.isArray(doc.service) ? (doc.service as Array<Record<string, unknown>>) : []
  const services: ServiceSummary[] = rawServices.map((s, i) => ({ ref: fragmentLabel(s.id, i, 's'), type: serviceType(s.type), hosts: [...new Set(endpointsOf(s).map((u) => (u.startsWith('did:') || u.startsWith('#') ? 'did-url' : hostOf(u))))] }))

  const { prime, primeNote } = await primeVariant(did, doc, methods, routing, rawServices, resolveWebvh)
  return { did, versionId, wsHost: hostOf(parsed.wsEndpoint), services, methods: summaries, edCandidates, routing, prime, primeNote, resolver }
}

async function primeVariant(
  did: string,
  doc: Record<string, unknown>,
  methods: Array<RawMethod & { absId: string }>,
  routing: RoutingVariant,
  services: Array<Record<string, unknown>>,
  resolveWebvh: (did: string) => Promise<ResolvedDoc>,
): Promise<{ prime: RoutingVariant | null; primeNote: PrimeNote }> {
  const tsp = services.find((s) => serviceType(s.type) === 'TSPTransport')
  if (!tsp) return { prime: null, primeNote: 'no-tsp-service' }
  const target = endpointsOf(tsp).find((u) => u.startsWith('did:') || u.startsWith('#'))
  if (!target) return { prime: null, primeNote: 'no-own-target' }
  const abs = absolute(target, did)
  const [base, frag] = abs.includes('#') ? [abs.slice(0, abs.indexOf('#')), abs.slice(abs.indexOf('#'))] : [abs, '']
  if (base === did) {
    if (!frag) return { prime: null, primeNote: 'same-as-default' }
    const m = methods.find((x) => x.absId === abs)
    const k = m ? keyOf(m) : null
    if (!m || !k || k.kind !== 'x25519' || !k.key || !relationIds(doc, 'keyAgreement', did).has(abs)) return { prime: null, primeNote: 'target-no-x25519' }
    if (sha256hex(k.key) === sha256hex(routing.x25519)) return { prime: null, primeNote: 'same-as-default' }
    return { prime: { firstHopVid: did, methodRef: fragmentLabel(abs, methods.indexOf(m), 'm'), x25519: k.key, sourceDocVersion: routing.sourceDocVersion }, primeNote: 'measured' }
  }
  if (!base.startsWith('did:webvh:')) return { prime: null, primeNote: 'non-webvh-target' }
  let other: ResolvedDoc
  try {
    other = await resolveWebvh(base)
  } catch {
    return { prime: null, primeNote: 'target-unresolved' }
  }
  const om = methodsOf(other.didDocument, base)
  const chosen = frag ? om.find((x) => x.absId === abs) : firstKeyAgreement(other.didDocument, base, om)
  const k = chosen ? keyOf(chosen) : null
  if (!chosen || !k || k.kind !== 'x25519' || !k.key) return { prime: null, primeNote: 'target-no-x25519' }
  return { prime: { firstHopVid: base, methodRef: fragmentLabel(chosen.absId, om.indexOf(chosen), 'm'), x25519: k.key, sourceDocVersion: versionLabel(other.didDocumentMetadata?.versionId) }, primeNote: 'measured' }
}
