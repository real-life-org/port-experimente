// A did:webvh 1.0 log, written and verified without witnesses, watchers or a
// web location. The DID string is a template with `{SCID}` and the value of
// `parameters.method` is a setting, so the same code writes and verifies
// `did:webvh:{SCID}:<host>`, `did:vh:{SCID}` and `did:scid:vh:1:{SCID}`
// (see profiles.ts). No name is built in.
//
// Followed (spec sources read 2026-11-28):
//   did:webvh 1.0, spec-v1.0/specification.md: "The DID Log File",
//     "Create (Register)", "Read (Resolve)", "Update (Rotate)", "Deactivate",
//     "did:webvh DID Method Parameters", "SCID Generation and Verification",
//     "Entry Hash Generation and Verification", "Authorized Keys",
//     "Pre-Rotation Key Hash Generation and Verification".
//   did:vh (editor's draft), spec/specification.md: the same sections, where
//     they are stricter (whole seconds, nothing after a deactivating entry,
//     no key authorized after `updateKeys: []`).
// Where this code reads the text one way among several, NOTES.md says so.

import { anchorOfEd, base58, diSign, diVerify, edRawOfAnchor, fromBase58, jcs, sha, type KeyPair } from 'rltp-lib'

/** Which DID method a log is written and verified as. */
export interface Profile {
  /** The DID with the placeholder, e.g. `did:vh:{SCID}`. */
  did: string
  /** The value of `parameters.method` in the first entry. */
  method: string
  /** The names a `parameters` object may carry under this method. */
  parameters: readonly string[]
}

export interface Proof {
  type: string
  cryptosuite: string
  verificationMethod: string
  created: string
  proofPurpose: string
  proofValue: string
  [k: string]: unknown
}

export interface Entry {
  versionId: string
  versionTime: string
  parameters: Record<string, unknown>
  state: Record<string, unknown>
  proof: Proof[]
}

/** What one verified entry leaves in force. */
export interface Version {
  versionId: string
  versionNumber: number
  versionTime: string
  doc: Record<string, unknown>
  updateKeys: string[]
  nextKeyHashes: string[]
  deactivated: boolean
}

export type LogCheck =
  | { ok: true, did: string, scid: string, versions: Version[], head: Version }
  | { ok: false, at: number, reason: string }

const PLACEHOLDER = '{SCID}'
const te = new TextEncoder()
const SHA256 = [0x12, 0x20]

/** base58btc(multihash(bytes, SHA-256)), without a multibase prefix. */
async function mh (bytes: Uint8Array): Promise<string> {
  return base58(Uint8Array.from([...SHA256, ...await sha(bytes)]))
}
const isSha256Mh = (s: unknown): boolean => {
  if (typeof s !== 'string') return false
  const b = fromBase58(s)
  return b !== null && b.length === 34 && b[0] === 0x12 && b[1] === 0x20 && base58(b) === s
}
const hashOf = async (o: unknown): Promise<string> => mh(te.encode(jcs(o)))

/** The multikey of an Ed25519 public key: `z` + base58btc(0xed01 || key). */
export const multikey = (pubRaw: Uint8Array): string => anchorOfEd(pubRaw).slice('did:key:'.length)
/** The raw key of an Ed25519 multikey, or null. */
export const rawOfMultikey = (mk: unknown): Uint8Array | null => typeof mk === 'string' ? edRawOfAnchor('did:key:' + mk) : null
/** The pre-rotation hash of a multikey: base58btc(multihash(multikey)). */
export const keyHash = (mk: string): Promise<string> => mh(te.encode(mk))
export const didOf = (profile: Profile, scid: string): string => profile.did.replaceAll(PLACEHOLDER, scid)

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T
const replaceAll = <T>(o: T, from: string, to: string): T => JSON.parse(JSON.stringify(o).replaceAll(from, to)) as T

/** A DID document with one Ed25519 key for `authentication`. */
export function didDocument (did: string, authKey: Uint8Array): Record<string, unknown> {
  const vm = `${did}#key-1`
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    verificationMethod: [{ id: vm, type: 'Multikey', controller: did, publicKeyMultibase: multikey(authKey) }],
    authentication: [vm],
  }
}

/** The Ed25519 keys a document lists under `authentication`, by id. */
export function authenticationKeys (doc: Record<string, unknown>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const vms = Array.isArray(doc.verificationMethod) ? doc.verificationMethod as unknown[] : []
  const byId = new Map<string, unknown>()
  for (const v of vms) if (v && typeof v === 'object' && typeof (v as any).id === 'string') byId.set((v as any).id, v)
  const auth = Array.isArray(doc.authentication) ? doc.authentication as unknown[] : []
  for (const a of auth) {
    const vm: any = typeof a === 'string' ? byId.get(a) : a
    if (!vm || typeof vm.id !== 'string' || vm.type !== 'Multikey' || vm.controller !== doc.id) continue
    const raw = rawOfMultikey(vm.publicKeyMultibase)
    if (raw) out.set(vm.id, raw)
  }
  return out
}

/** Sign an entry (without proof) with eddsa-jcs-2022, proofPurpose assertionMethod. */
async function signEntry (body: Omit<Entry, 'proof'>, key: KeyPair, created = body.versionTime): Promise<Entry> {
  const signed = await diSign({ anchor: anchorOfEd(key.pubRaw), ed: { priv: key.priv } }, body, created)
  const { proof, ...rest } = signed
  return { ...rest, proof: [proof as Proof] }
}

export interface CreateOptions {
  profile: Profile
  /** Signs the first entry; its multikey is the first `updateKeys`. */
  updateKey: KeyPair
  /** The public keys that may sign the next entry (pre-rotation); none turns pre-rotation off. */
  next: Uint8Array[]
  /** The key the document lists for `authentication`. */
  authKey: Uint8Array
  /** `versionTime`, whole seconds, UTC. */
  time: string
}

/** Write the first entry (Create, steps 1 to 6). */
export async function create (o: CreateOptions): Promise<Entry[]> {
  const prelim = {
    versionId: PLACEHOLDER,
    versionTime: o.time,
    parameters: {
      method: o.profile.method,
      scid: PLACEHOLDER,
      updateKeys: [multikey(o.updateKey.pubRaw)],
      nextKeyHashes: await Promise.all(o.next.map((k) => keyHash(multikey(k)))),
    },
    state: didDocument(o.profile.did, o.authKey),
  }
  const scid = await hashOf(prelim)
  const entry = replaceAll(prelim, PLACEHOLDER, scid)
  entry.versionId = `1-${await hashOf(entry)}`   // versionId here is the SCID: the predecessor of the first entry
  return [await signEntry(entry, o.updateKey)]
}

export interface AppendOptions {
  /** The parameters of the new entry, as written (`{}` when nothing changes). */
  parameters: Record<string, unknown>
  /** The document of the new version. */
  state: Record<string, unknown>
  signer: KeyPair
  time: string
  /** The proof's `created`; `time` when absent. */
  created?: string
}

/** Append one entry, whatever it says. Nothing is checked here; `verify` does. */
export async function append (log: Entry[], o: AppendOptions): Promise<Entry[]> {
  const prev = log[log.length - 1]
  if (!prev) throw new Error('append: empty log')
  const n = Number(prev.versionId.split('-')[0]) + 1
  const body = { versionId: prev.versionId, versionTime: o.time, parameters: clone(o.parameters), state: clone(o.state) }
  body.versionId = `${n}-${await hashOf(body)}`
  return [...log, await signEntry(body, o.signer, o.created)]
}

export interface RotateOptions {
  /** A key whose hash the head committed to; it signs and becomes `updateKeys`. */
  signer: KeyPair
  /** The keys the new entry commits to; none turns pre-rotation off. */
  next: Uint8Array[]
  /** A new authentication key; unchanged when absent. */
  authKey?: Uint8Array
  time: string
}

/** A key change under pre-rotation: the committed key signs and becomes the update key. */
export async function rotate (log: Entry[], o: RotateOptions): Promise<Entry[]> {
  const head = log[log.length - 1] as Entry
  const did = head.state.id as string
  return append(log, {
    parameters: { updateKeys: [multikey(o.signer.pubRaw)], nextKeyHashes: await Promise.all(o.next.map((k) => keyHash(multikey(k)))) },
    state: o.authKey ? didDocument(did, o.authKey) : head.state,
    signer: o.signer,
    time: o.time,
  })
}

/**
 * Deactivate. Under pre-rotation this takes two entries (Deactivate): the
 * committed key turns pre-rotation off, then the same key, now the active
 * one, writes `deactivated: true` with `updateKeys: []`. The second entry is
 * one second after `time`.
 */
export async function deactivate (log: Entry[], o: { signer: KeyPair, time: string }): Promise<Entry[]> {
  const head = log[log.length - 1] as Entry
  let out = log
  let t = o.time
  if (committed(log).length > 0) {
    out = await rotate(out, { signer: o.signer, next: [], time: t })
    t = new Date(Date.parse(t) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  return append(out, { parameters: { deactivated: true, updateKeys: [] }, state: head.state, signer: o.signer, time: t })
}
/** The `nextKeyHashes` in force at the head: the last entry that set it. */
function committed (log: Entry[]): unknown[] {
  for (let i = log.length - 1; i >= 0; i--) { const n = log[i]?.parameters.nextKeyHashes; if (Array.isArray(n)) return n }
  return []
}

/** The JSON Lines form (one entry per line, `\n` after each). */
export const toJsonl = (log: Entry[]): string => log.map((e) => JSON.stringify(e) + '\n').join('')
export function fromJsonl (text: string): unknown[] | null {
  try { return text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) } catch { return null }
}

// ── verification ────────────────────────────────────────────────────────

const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|\+00:00)$/
/** A UTC ISO 8601 time in whole seconds, as an instant, or null. */
function timeOf (t: unknown): number | null {
  if (typeof t !== 'string' || !TIME.test(t)) return null
  const ms = Date.parse(t)
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== t.slice(0, 19)) return null
  return ms
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const VERSION_ID = /^([1-9][0-9]*)-([^-]+)$/

export interface VerifyOptions {
  profile: Profile
  /** The verifier's clock. */
  now: Date
  /** How far in the future a `versionTime` may lie, in seconds (spec: SHOULD be at most 5 minutes). */
  toleranceSec?: number
  /** The DID the caller asked for; when given, the log must be that DID's. */
  did?: string
}

/**
 * Verify a whole log (Read, "For each entry", steps 1 to 9 without
 * witnesses). The log is valid only if every entry is: a caller that
 * applies peer-to-peer updates asks for the last entry, and a failure at
 * any entry fails that request.
 */
export async function verify (input: unknown, o: VerifyOptions): Promise<LogCheck> {
  const fail = (at: number, reason: string): LogCheck => ({ ok: false, at, reason })
  if (!Array.isArray(input) || input.length === 0) return fail(0, 'not a log')
  const limit = o.now.getTime() + (o.toleranceSec ?? 300) * 1000
  const allowed = new Set(o.profile.parameters)
  const versions: Version[] = []
  let scid = ''
  let did = ''
  let updateKeys: string[] = []
  let nextKeyHashes: string[] = []
  let prevId = ''
  let prevTime = -Infinity
  let deactivated = false

  for (let i = 0; i < input.length; i++) {
    const e = input[i]
    try {
      if (!isObj(e)) return fail(i, 'entry is not an object')
      const keys = Object.keys(e).sort().join(',')
      if (keys !== 'parameters,proof,state,versionId,versionTime') return fail(i, 'entry has other properties than versionId, versionTime, parameters, state, proof')
      const { versionId, versionTime, parameters: p, state, proof } = e as unknown as Entry
      if (deactivated) return fail(i, 'entry after deactivation')

      // 1. parameters
      if (!isObj(p)) return fail(i, 'parameters is not an object')
      for (const [k, v] of Object.entries(p)) {
        if (!allowed.has(k)) return fail(i, `parameter ${k} is not defined for this method`)
        if (v === null) return fail(i, `parameter ${k} is null`)
      }
      if (i === 0) {
        if (p.method !== o.profile.method) return fail(i, 'method is missing or not supported')
        if (typeof p.scid !== 'string') return fail(i, 'scid is missing')
        if (!Array.isArray(p.updateKeys)) return fail(i, 'updateKeys is missing')
      } else {
        if ('method' in p && p.method !== o.profile.method) return fail(i, 'method is not supported')
        if ('scid' in p) return fail(i, 'scid in a later entry')
      }
      if ('updateKeys' in p && !(isStrArr(p.updateKeys) && p.updateKeys.every((k) => rawOfMultikey(k) !== null))) return fail(i, 'updateKeys is not a list of Ed25519 multikeys')
      if ('nextKeyHashes' in p && !(isStrArr(p.nextKeyHashes) && p.nextKeyHashes.every(isSha256Mh))) return fail(i, 'nextKeyHashes is not a list of SHA-256 multihashes')
      if ('portable' in p && p.portable !== false) return fail(i, 'portable is not false (portability is not supported here)')
      if ('witness' in p && !(isObj(p.witness) && Object.keys(p.witness).length === 0)) return fail(i, 'witnesses are not supported here')
      if ('watchers' in p && !isStrArr(p.watchers)) return fail(i, 'watchers is not a list of strings')
      if ('ttl' in p && !(Number.isInteger(p.ttl) && (p.ttl as number) >= 0 && (p.ttl as number) <= 2 ** 31 - 1)) return fail(i, 'ttl is not an unsigned integer')
      if ('deactivated' in p && typeof p.deactivated !== 'boolean') return fail(i, 'deactivated is not a boolean')

      // 7. pre-rotation, and the keys that may sign this entry
      const prerotation = nextKeyHashes.length > 0
      let active: string[]
      if (i === 0) active = p.updateKeys as string[]
      else if (prerotation) {
        if (!('updateKeys' in p) || !('nextKeyHashes' in p)) return fail(i, 'pre-rotation is active and updateKeys or nextKeyHashes is missing')
        for (const k of p.updateKeys as string[]) if (!nextKeyHashes.includes(await keyHash(k))) return fail(i, 'an update key was not committed to by the previous entry')
        active = p.updateKeys as string[]
      } else active = updateKeys
      if (active.length === 0) return fail(i, 'no key is authorized to sign this entry')

      // 2. the proof
      if (!Array.isArray(proof) || proof.length !== 1 || !isObj(proof[0])) return fail(i, 'proof is not a list of one proof')
      const pr = proof[0] as Proof
      if (pr.type !== 'DataIntegrityProof') return fail(i, 'proof type is not DataIntegrityProof')
      if (pr.cryptosuite !== 'eddsa-jcs-2022') return fail(i, 'cryptosuite is not eddsa-jcs-2022')
      if (pr.proofPurpose !== 'assertionMethod') return fail(i, 'proofPurpose is not assertionMethod')
      const vm = typeof pr.verificationMethod === 'string' ? pr.verificationMethod : ''
      const mk = vm.startsWith('did:key:') ? vm.slice('did:key:'.length).split('#')[0] as string : ''
      if (vm !== `did:key:${mk}#${mk}` || !active.includes(mk)) return fail(i, 'proof is not by an authorized key')
      const { proof: _p, ...body } = e as unknown as Entry
      if (!await diVerify({ ...body, proof: pr })) return fail(i, 'signature does not verify')

      // 3. versionId
      const m = typeof versionId === 'string' ? VERSION_ID.exec(versionId) : null
      if (!m) return fail(i, 'versionId is not <number>-<entryHash>')
      if (Number(m[1]) !== i + 1) return fail(i, 'version number is not the next one')
      const entryHash = m[2] as string
      if (!isSha256Mh(entryHash)) return fail(i, 'entryHash is not a SHA-256 multihash')

      // 5. the SCID (first entry), before the entry hash, which uses it
      if (i === 0) {
        scid = p.scid as string
        if (!/^[1-9A-HJ-NP-Za-km-z]{46}$/.test(scid) || !isSha256Mh(scid)) return fail(i, 'scid is not a SHA-256 multihash of 46 characters')
        const prelim = replaceAll({ ...body, versionId: PLACEHOLDER }, scid, PLACEHOLDER)
        if (await hashOf(prelim) !== scid) return fail(i, 'scid does not match the first entry')
        did = didOf(o.profile, scid)
        if (o.did !== undefined && o.did !== did) return fail(i, 'the log is not the log of this DID')
      }
      if (await hashOf({ ...body, versionId: i === 0 ? scid : prevId }) !== entryHash) return fail(i, 'entryHash does not match')

      // 4. versionTime
      const t = timeOf(versionTime)
      if (t === null) return fail(i, 'versionTime is not a UTC time in whole seconds')
      if (t <= prevTime) return fail(i, 'versionTime is not later than the previous entry\'s')
      if (t > limit) return fail(i, 'versionTime is in the future')

      // 6. the document
      if (!isObj(state) || state.id !== did) return fail(i, 'state.id is not the DID')

      // 8. collect
      if (Array.isArray(p.updateKeys)) updateKeys = p.updateKeys as string[]
      if (Array.isArray(p.nextKeyHashes)) nextKeyHashes = p.nextKeyHashes as string[]
      if (p.deactivated === true) deactivated = true
      versions.push({ versionId, versionNumber: i + 1, versionTime, doc: state, updateKeys, nextKeyHashes, deactivated })
      prevId = versionId
      prevTime = t
    } catch {
      return fail(i, 'entry cannot be processed')
    }
  }
  return { ok: true, did, scid, versions, head: versions[versions.length - 1] as Version }
}
