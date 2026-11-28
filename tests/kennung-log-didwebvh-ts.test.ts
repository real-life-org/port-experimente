import { expect, test } from 'vitest'
import { base58, platformSubtle, type KeyPair } from 'rltp-lib'
import { createDID, deactivateDID, defaultVerifier as verifier, deriveNextKeyHash, prepareDataForSigning, resolveDID, resolveDIDFromLog, updateDID, type DIDLog, type Signer } from 'didwebvh-ts'
import { fromJsonl, multikey, toJsonl, verify, type Entry } from '../src/lab/kennung-log/log'
import { scidVh, vh, webvh } from '../src/lab/kennung-log/profiles'
import { at, change, genesis, keyOf, tampered, threeEntries } from '../src/lab/kennung-log/scenarios'
import { deactivate } from '../src/lab/kennung-log/log'

// The cross-check against a foreign implementation: didwebvh-ts (DIF),
// pinned in package.json. It resolves over HTTP only through `fetch`, which
// its options let the caller supply, and from memory through
// `resolveDIDFromLog`; both are used, without a network.

const NOW = new Date()   // didwebvh-ts checks versionTime against the real clock; all test times are in the past

/** Serve one log at the URL didwebvh-ts derives from the DID, and record the URL. */
function serve (log: unknown[]) {
  const asked: string[] = []
  const fetch = async (url: string): Promise<Response> => { asked.push(url); return new Response(toJsonl(log as Entry[]), { headers: { 'content-type': 'text/jsonl' } }) }
  return { fetch, asked }
}

/** A didwebvh-ts signer backed by a key pair (eddsa-jcs-2022 over its own prepared data). */
const signer = (k: KeyPair): Signer => ({
  getVerificationMethodId: () => `did:key:${multikey(k.pubRaw)}#${multikey(k.pubRaw)}`,
  sign: async ({ document, proof }) => {
    const data = await prepareDataForSigning(document, proof)
    return { proofValue: 'z' + base58(new Uint8Array(await platformSubtle().sign('Ed25519', k.priv, data as BufferSource))) }
  },
})

test('a did:webvh log written by log.ts resolves with didwebvh-ts, over its fetch option and from memory', async () => {
  for (const [host, url] of [['example.com', 'https://example.com/.well-known/did.jsonl'], ['example.com%3A8443:dids:alice', 'https://example.com:8443/dids/alice/did.jsonl']] as const) {
    const log = await threeEntries(webvh(host))
    const head = log[2] as Entry
    const did = head.state.id as string
    const { fetch, asked } = serve(log)
    const r = await resolveDID(did, { fetch })
    expect(asked).toEqual([url])
    expect(r.didResolutionMetadata.error).toBeUndefined()
    expect(r.didDocumentMetadata.versionId).toBe(head.versionId)
    // didwebvh-ts adds the implicit #files and #whois services (DID URL Resolution); the rest is the head's document
    const { service, ...rest } = r.didDocument as any
    expect(rest).toEqual(head.state)
    expect(service.map((x: any) => x.id)).toEqual([`${did}#files`, `${did}#whois`])
    const m = await resolveDIDFromLog(log as unknown as DIDLog)
    expect(m.didResolutionMetadata.error).toBeUndefined()
    expect(m.didDocumentMetadata.versionId).toBe(head.versionId)
    // every earlier version too
    for (const e of log) expect((await resolveDID(did, { fetch, versionId: e.versionId })).didDocumentMetadata.versionId).toBe(e.versionId)
  }
})

test('a did:webvh log deactivated by log.ts is deactivated for didwebvh-ts', async () => {
  const o1 = await genesis(webvh('example.com'))
  const o2 = await change(o1, 'owner', 1, 1)
  const log = await deactivate(o2.log, { signer: o2.next, time: at(2) })
  const r = await resolveDID(log[0]!.state.id as string, serve(log))
  expect(r.didResolutionMetadata.error).toBeUndefined()
  expect(r.didDocumentMetadata.deactivated).toBe(true)
  expect(r.didDocumentMetadata.versionId).toBe(log[3]!.versionId)
})

test('a log written by didwebvh-ts (pre-rotation, two key changes, deactivation) verifies with log.ts', async () => {
  const [u0, u1, u2, a0, a1, a2] = await Promise.all(['u0', 'u1', 'u2', 'a0', 'a1', 'a2'].map((l) => keyOf(`didwebvh-ts ${l}`)))
  const mk = (k: KeyPair) => multikey(k!.pubRaw)
  const doc = (k: KeyPair) => ({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: '{DID}',
    verificationMethod: [{ id: '{DID}#key-1', type: 'Multikey', controller: '{DID}', publicKeyMultibase: mk(k) }],
    authentication: ['{DID}#key-1'],
  })
  const created = await createDID({ address: 'example.com', signer: signer(u0!), updateKeys: [mk(u0!)], nextKeyHashes: [await deriveNextKeyHash(mk(u1!))], didDocument: doc(a0!) as any, created: at(0), verifier })
  const did = created.did
  const withDid = (k: KeyPair) => JSON.parse(JSON.stringify(doc(k)).replaceAll('{DID}', did))
  const v2 = await updateDID({ log: created.log, signer: signer(u1!), updateKeys: [mk(u1!)], nextKeyHashes: [await deriveNextKeyHash(mk(u2!))], didDocument: withDid(a1!), updated: at(1), verifier })
  const v3 = await updateDID({ log: v2.log, signer: signer(u2!), updateKeys: [mk(u2!)], nextKeyHashes: [], didDocument: withDid(a2!), updated: at(2), verifier })
  const v4 = await deactivateDID({ log: v3.log, signer: signer(u2!), verifier })
  // As it travels: JSON Lines (didwebvh-ts's objects carry `undefined` members, which JSON drops).
  const wire = (log: DIDLog): unknown[] => fromJsonl(log.map((e) => JSON.stringify(e)).join('\n')) as unknown[]
  for (const log of [created.log, v2.log, v3.log, v4.log].map(wire) as Entry[][]) {
    const r = await verify(log, { profile: webvh('example.com'), now: NOW, did })
    expect(r.ok ? r.head.versionId : r).toBe(log[log.length - 1]!.versionId)
  }
  const r = await verify(wire(v4.log), { profile: webvh('example.com'), now: NOW })
  expect(r.ok && r.head.deactivated).toBe(true)
  expect(r.ok && r.versions.map((v) => v.versionNumber)).toEqual([1, 2, 3, 4])
})

test('tampered logs: what log.ts and didwebvh-ts each reject', async () => {
  const cases = await tampered(webvh('example.com'))
  const disagree: string[] = []
  let both = 0
  for (const c of cases) {
    const mine = await verify(c.log, { profile: webvh('example.com'), now: NOW })
    const theirs = await resolveDIDFromLog(c.log as unknown as DIDLog, { versionId: c.log[c.log.length - 1]!.versionId })
    const theyReject = theirs.didResolutionMetadata.error !== undefined
    if (!mine.ok && theyReject) both++
    else disagree.push(`${c.field} (entry ${c.entry}): log.ts ${mine.ok ? 'accepts' : 'rejects'}, didwebvh-ts ${theyReject ? 'rejects' : 'accepts'}`)
  }
  // log.ts takes the prose literally (proof is a list holding one proof; an
  // entry has the five properties). didwebvh-ts accepts a proof set and a
  // bare proof object (the JSON schema allows both), and it rebuilds the
  // first entry from its four signed fields, so an extra property there is
  // neither hashed nor rejected; in a later entry it breaks the entry hash.
  expect({ cases: cases.length, both, disagree }).toEqual({
    cases: 42,
    both: 37,
    disagree: [
      'proof: the proof twice (entry 1): log.ts rejects, didwebvh-ts accepts',
      'proof: the proof twice (entry 2): log.ts rejects, didwebvh-ts accepts',
      'proof: an object, not a list (entry 1): log.ts rejects, didwebvh-ts accepts',
      'proof: an object, not a list (entry 2): log.ts rejects, didwebvh-ts accepts',
      'entry: an extra property (entry 1): log.ts rejects, didwebvh-ts accepts',
    ],
  })
})

test('host-free logs written by log.ts, given to didwebvh-ts: the missing host alone fails', async () => {
  const out: Record<string, string | undefined> = {}
  const cases = [
    ['did:webvh with a host, method did:webvh:1.0', webvh('example.com')],
    // the same method value; only the DID differs
    ['did:webvh without a host, method did:webvh:1.0', { ...webvh('example.com'), did: 'did:webvh:{SCID}' }],
    ['did:vh, method did:webvh:1.0', { ...vh, method: 'did:webvh:1.0' }],
    ['did:vh, method did:vh:1.0', vh],
    ['did:scid:vh:1, method did:vh:1.0', scidVh],
  ] as const
  for (const [name, p] of cases) {
    const log = (await genesis(p)).log
    const r = await resolveDIDFromLog(log as unknown as DIDLog)
    out[name] = r.didResolutionMetadata.error === undefined ? 'resolves' : `${r.didResolutionMetadata.error}: ${(r.didResolutionMetadata as any).problemDetails?.detail}`
  }
  // didwebvh#305: the did:webvh libraries do not take a log without a host.
  expect(out).toEqual({
    'did:webvh with a host, method did:webvh:1.0': 'resolves',
    'did:webvh without a host, method did:webvh:1.0': "invalidDid: version '1' state.id must include SCID and domain segments",
    'did:vh, method did:webvh:1.0': "invalidDid: version '1' state.id must be a valid did:webvh identifier",
    'did:vh, method did:vh:1.0': "invalidDid: 'did:vh:1.0' is not a supported method version.",
    'did:scid:vh:1, method did:vh:1.0': "invalidDid: 'did:vh:1.0' is not a supported method version.",
  })
})
