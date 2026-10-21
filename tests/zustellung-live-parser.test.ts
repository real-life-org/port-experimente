// E11b step 1, offline: the classifier of incoming TSP frames (draft 3 §5,
// review 2 B1, review 3 C3/C5). Self-packed frames of every type; control
// frames never reach `receive()`.

import { describe, expect, it, vi } from 'vitest'
import { decodeEnvelope, pack, packAccept, packCancel, packInvite, packNested, packRouted, unpack } from '@openvtc/vti-tsp-js'
import * as tp from '@real-life/trust-protocol'
import { diSign, jcs, seal, type Json } from '@real-life/trust-protocol'
import { ACK_TYPE, sealDoc } from '../src/lab/zustellung'
import { classifyFrame, deriveWireIdentity, FRAME_CLASSES, makeParty, PositiveList, SendRegistry, seededRand, sha256hex, XrfiRegistry, hexOf, gatedWireIdentity, type ClassifyContext, type FrameClass, type SendRecord } from '../src/lab/zustellung-live'
import { FAKE_DID, mediatorKeys, paddingFrame, rev2Patched, unknownMarkerFrame, xctlFrame } from './zustellung-live-fixtures'

vi.mock('@real-life/trust-protocol', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@real-life/trust-protocol')>()
  return { ...orig, receive: vi.fn(orig.receive) }
})

const enc = new TextEncoder()

async function world(seed: number) {
  const rand = seededRand(seed)
  const med = mediatorKeys(seed % 200 + 1)
  const me = await deriveWireIdentity(rand(32), FAKE_DID, rand(32), 'connection')
  const peer = await deriveWireIdentity(rand(32), FAKE_DID, rand(32), 'egress')
  const stranger = await deriveWireIdentity(rand(32), FAKE_DID, rand(32), 'connection')
  const other = await deriveWireIdentity(rand(32), FAKE_DID, rand(32), 'connection')
  const meParty = await makeParty('B', rand)
  const peerParty = await makeParty('A', rand)
  const list = new PositiveList([
    { sender: peer.did, receiver: me.did, signing: [{ ref: 'peer', pub: peer.edPublic }], receiverSecret: me.xSecret, allowed: new Set(['direct']) },
    { sender: FAKE_DID, receiver: me.did, signing: [{ ref: 'key-0', pub: med.edPublic }], receiverSecret: me.xSecret, allowed: new Set(['control']) },
  ])
  const registry = new SendRegistry()
  const xrfi = new XrfiRegistry()
  const completed = new Set<string>()
  const ctx: ClassifyContext = { list, registry, xrfi, socket: 'B.AB.conn', resolve: (rkid) => (rkid === meParty.rkid ? meParty.x.priv : undefined), completed }
  const fromPeer = (payload: Uint8Array) => pack(payload, peer.did, me.did, { senderSigningKey: peer.edSecret, receiverEncryptionKey: me.xPublic })
  const fromMed = { senderSigningKey: med.edSecret, receiverEncryptionKey: me.xPublic }
  return { rand, med, me, peer, stranger, other, meParty, peerParty, list, registry, xrfi, completed, ctx, fromPeer, fromMed }
}

function record(id: string, kind: SendRecord['kind'], payload: Uint8Array, inner: Uint8Array, outer: Uint8Array | null = null): SendRecord {
  return { id, group: 'g', form: 'D-c', stage: 0, rel: 'AB', dir: 'x2y', run: 1, kind, payloadDigest: sha256hex(payload), innerDigest: sha256hex(inner), outerDigest: outer ? sha256hex(outer) : null, sizes: { payload: payload.length, inner: inner.length, outer: outer?.length ?? null, wire: (outer ?? inner).length }, tSend: 0, receiverSocket: 'B.AB.conn' }
}

describe('E11b classifier: one class per frame, parser rule (#95, MV-24)', () => {
  it('classifies every frame type into exactly the expected class', async () => {
    const w = await world(1)
    const cases: Array<[string, Uint8Array, FrameClass]> = []
    const add = (name: string, frame: Uint8Array, cls: FrameClass) => cases.push([name, frame, cls])

    add('direct empty', (await w.fromPeer(new Uint8Array(0))).bytes, 'empty-direct')
    add('direct not JSON', (await w.fromPeer(enc.encode('\u0000not json'))).bytes, 'payload-not-json')
    const probePayload = w.rand(64)
    const probe = await w.fromPeer(probePayload)
    w.registry.add(record('p1', 'probe', probePayload, probe.bytes))
    add('probe', probe.bytes, 'probe')
    const { bytes: docBytes } = await sealDoc(w.peerParty, w.meParty, { n: 1 }, 't1')
    add('doc', (await w.fromPeer(docBytes)).bytes, 'doc')
    const ackDoc = await diSign({ anchor: w.peerParty.anchor, ed: { priv: w.peerParty.ed.priv } }, { id: 'a', type: ACK_TYPE, issuer: w.peerParty.anchor, recipient: w.meParty.anchor, threadId: 't1', issuedAt: '2026-10-21T00:00:00.000Z', payload: { ref: 'u', meaning: 'received' } }, '2026-10-21T00:00:00.000Z')
    add('ack', (await w.fromPeer(enc.encode(jcs((await seal(ackDoc as unknown as Json, w.meParty.rkid)) as unknown as Json)))).bytes, 'ack')
    // Poison vectors (giftvektoren 18.10., Nr. 1, 2, 34, 35): readable JSON that is no envelope.
    add('JSON null', (await w.fromPeer(enc.encode('null'))).bytes, 'doc-unknown')
    add('JSON __proto__', (await w.fromPeer(enc.encode('{"__proto__":{"ct":"x"},"rkid":"z"}'))).bytes, 'doc-unknown')
    add('JSON constructor', (await w.fromPeer(enc.encode('{"constructor":1}'))).bytes, 'doc-unknown')
    add('envelope for someone else', (await w.fromPeer(enc.encode(jcs((await seal({ a: 1 }, w.peerParty.rkid)) as unknown as Json)))).bytes, 'doc-unknown')
    add('control invite (mediator)', (await packInvite(FAKE_DID, w.me.did, w.fromMed)).bytes, 'control/invite')
    add('control accept (mediator)', (await packAccept(new Uint8Array(32), FAKE_DID, w.me.did, w.fromMed)).bytes, 'control/accept')
    add('control cancel (mediator)', (await packCancel(new Uint8Array(32), FAKE_DID, w.me.did, w.fromMed)).bytes, 'control/cancel')
    add('control opaque XCTL', await xctlFrame(FAKE_DID, w.me.did, w.med.edSecret, w.me.xPublic, enc.encode('x')), 'control-opaque')
    const inner = await pack(enc.encode('inner'), w.peer.did, w.me.did, { senderSigningKey: w.peer.edSecret, receiverEncryptionKey: w.me.xPublic })
    add('routed to me', (await packRouted(inner.bytes, [w.other.did], w.peer.did, w.me.did, { senderSigningKey: w.peer.edSecret, receiverEncryptionKey: w.me.xPublic })).bytes, 'wrong-type/routed')
    add('nested to me', (await packNested(inner.bytes, w.peer.did, w.me.did, { senderSigningKey: w.peer.edSecret, receiverEncryptionKey: w.me.xPublic })).bytes, 'wrong-type/nested')
    add('padding', await paddingFrame(w.peer.did, w.me.did, w.peer.edSecret, w.me.xPublic), 'wrong-type/padding')
    add('direct from mediator', (await pack(enc.encode('m'), FAKE_DID, w.me.did, w.fromMed)).bytes, 'wrong-type/direct')
    add('control from peer', (await packInvite(w.peer.did, w.me.did, { senderSigningKey: w.peer.edSecret, receiverEncryptionKey: w.me.xPublic })).bytes, 'wrong-type/control')
    add('foreign sender', (await pack(enc.encode('f'), w.stranger.did, w.me.did, { senderSigningKey: w.stranger.edSecret, receiverEncryptionKey: w.me.xPublic })).bytes, 'unopenable/unlisted')
    add('wrong receiver', (await pack(enc.encode('f'), w.peer.did, w.other.did, { senderSigningKey: w.peer.edSecret, receiverEncryptionKey: w.other.xPublic })).bytes, 'unopenable/unlisted')
    add('listed sender, wrong key', (await pack(enc.encode('f'), w.peer.did, w.me.did, { senderSigningKey: w.stranger.edSecret, receiverEncryptionKey: w.me.xPublic })).bytes, 'unopenable/unpack-failed')
    add('sealed to another key', (await pack(enc.encode('f'), w.peer.did, w.me.did, { senderSigningKey: w.peer.edSecret, receiverEncryptionKey: w.other.xPublic })).bytes, 'unopenable/unpack-failed')
    add('unknown payload marker', await unknownMarkerFrame(w.peer.did, w.me.did, w.peer.edSecret, w.me.xPublic), 'unopenable/unpack-failed')
    // Rev 2 frames fail in the library before the revision check (review 3, documented).
    add('Rev 2 header', rev2Patched(probe.bytes), 'unopenable/unpack-failed')
    add('garbage', w.rand(80), 'unopenable/undecodable')
    add('empty', new Uint8Array(0), 'unopenable/undecodable')

    const seen = new Set<FrameClass>()
    for (const [name, frame, cls] of cases) {
      const c = await classifyFrame(frame, w.ctx)
      expect(c.cls, name).toBe(cls)
      expect(FRAME_CLASSES).toContain(c.cls)
      expect(c.size).toBe(frame.length)
      seen.add(c.cls)
    }
    // Every class but the two defensive ones the Rev 3 library path cannot reach (unpack checks revision and pair first).
    const unreachable = new Set<FrameClass>(['wrong-revision', 'mismatch', 'wrong-type/other'])
    expect(FRAME_CLASSES.filter((c) => !seen.has(c) && !unreachable.has(c))).toEqual([])
  })

  it('never hands a control or refused frame to receive()', async () => {
    const w = await world(2)
    const spy = vi.mocked(tp.receive)
    spy.mockClear()
    const frames = [
      (await packInvite(FAKE_DID, w.me.did, w.fromMed)).bytes,
      (await packAccept(new Uint8Array(32), FAKE_DID, w.me.did, w.fromMed)).bytes,
      (await packCancel(new Uint8Array(32), FAKE_DID, w.me.did, w.fromMed)).bytes,
      await xctlFrame(FAKE_DID, w.me.did, w.med.edSecret, w.me.xPublic, enc.encode('{"ct":"x"}')),
      await paddingFrame(w.peer.did, w.me.did, w.peer.edSecret, w.me.xPublic),
      (await pack(enc.encode('{"ct":"x"}'), FAKE_DID, w.me.did, w.fromMed)).bytes,
      (await w.fromPeer(new Uint8Array(0))).bytes,
    ]
    for (const f of frames) {
      const c = await classifyFrame(f, w.ctx)
      expect(c.received).toBeUndefined()
      expect(c.verdict).toBeUndefined()
    }
    expect(spy).not.toHaveBeenCalled()
    // Probes are matched by payload digest and never reach receive() either.
    const payload = enc.encode(JSON.stringify({ ct: 'x', rkid: w.meParty.rkid }))
    const p = await w.fromPeer(payload)
    w.registry.add(record('p', 'probe', payload, p.bytes))
    expect((await classifyFrame(p.bytes, w.ctx)).cls).toBe('probe')
    expect(spy).not.toHaveBeenCalled()
  })

  it('correlates XRFA/XRFD with the threadDigest of the own invite on the same socket only', async () => {
    const w = await world(3)
    const inv = await packInvite(w.me.did, FAKE_DID, { senderSigningKey: w.me.edSecret, receiverEncryptionKey: w.med.xPublic })
    w.xrfi.add({ group: 'g', socket: 'B.AB.conn', threadDigest: hexOf(inv.threadDigest), tSend: 0 })
    const acc = await packAccept(inv.threadDigest, FAKE_DID, w.me.did, w.fromMed)
    const c = await classifyFrame(acc.bytes, w.ctx)
    expect([c.cls, c.correlation, c.signatureMethod]).toEqual(['control/accept', 'own-xrfi', 'key-0'])
    // sha256 of the invite bytes is not what an accept names
    const wrong = await packAccept(new Uint8Array(Buffer.from(sha256hex(inv.bytes), 'hex')), FAKE_DID, w.me.did, w.fromMed)
    expect((await classifyFrame(wrong.bytes, w.ctx)).correlation).toBe('unknown')
    const cancel = await packCancel(inv.threadDigest, FAKE_DID, w.me.did, w.fromMed)
    expect((await classifyFrame(cancel.bytes, w.ctx)).correlation).toBe('own-xrfi')
    expect((await classifyFrame(acc.bytes, { ...w.ctx, socket: 'A.AB.conn' })).correlation).toBe('unknown')
    expect((await classifyFrame((await packInvite(FAKE_DID, w.me.did, w.fromMed)).bytes, w.ctx)).correlation).toBe('none')
  })

  it('tries the mediator key candidates in order and names the opening method', async () => {
    const w = await world(4)
    const wrongKey = mediatorKeys(99)
    const list = new PositiveList([{ sender: FAKE_DID, receiver: w.me.did, signing: [{ ref: 'm0', pub: wrongKey.edPublic }, { ref: 'key-0', pub: w.med.edPublic }], receiverSecret: w.me.xSecret, allowed: new Set(['control']) }])
    const c = await classifyFrame((await packInvite(FAKE_DID, w.me.did, w.fromMed)).bytes, { ...w.ctx, list })
    expect([c.cls, c.signatureMethod]).toEqual(['control/invite', 'key-0'])
  })

  it('matches by inner and outer frame digest with full digests, and by payload after opening', async () => {
    const w = await world(5)
    const payload = w.rand(64)
    const inner = await w.fromPeer(payload)
    const outer = await packRouted(inner.bytes, [w.me.did], w.peer.did, FAKE_DID, { senderSigningKey: w.peer.edSecret, receiverEncryptionKey: w.med.xPublic })
    w.registry.add(record('r', 'probe', payload, inner.bytes, outer.bytes))
    const ci = await classifyFrame(inner.bytes, w.ctx)
    expect([ci.cls, ci.recordId, ci.layer, ci.innerBytesEqual, ci.outerBytesEqual]).toEqual(['probe', 'r', 'inner', true, false])
    const co = await classifyFrame(outer.bytes, w.ctx)
    expect([co.cls, co.recordId, co.layer, co.outerBytesEqual]).toEqual(['unopenable/unlisted', 'r', 'outer', true])
    // Re-packed (fresh HPKE): no frame match, payload match after opening
    const again = await w.fromPeer(payload)
    const ca = await classifyFrame(again.bytes, w.ctx)
    expect([ca.cls, ca.recordId, ca.layer, ca.innerBytesEqual]).toEqual(['probe', 'r', 'payload', false])
  })

  it('a duplicate doc frame reads duplicate-known only after the caller completed it; classify never writes the set', async () => {
    const w = await world(6)
    const { bytes } = await sealDoc(w.peerParty, w.meParty, { n: 2 }, 't2')
    const f = (await w.fromPeer(bytes)).bytes
    const a = await classifyFrame(f, w.ctx)
    const b = await classifyFrame(f, w.ctx)
    expect([a.verdict, b.verdict, w.completed.size]).toEqual(['unique', 'unique', 0])
    w.completed.add(a.received!.digest!)
    expect((await classifyFrame(f, w.ctx)).verdict).toBe('duplicate-known')
  })

  it('RT6 (offline fact): after opening the routing layer the mediator reads inner sender and receiver', async () => {
    const w = await world(7)
    const inner = await w.fromPeer(w.rand(64))
    const outer = await packRouted(inner.bytes, [w.me.did], w.peer.did, FAKE_DID, { senderSigningKey: w.peer.edSecret, receiverEncryptionKey: w.med.xPublic })
    expect(decodeEnvelope(outer.bytes).envelope).toEqual({ sender: w.peer.did, receiver: FAKE_DID })
    const opened = await unpack(outer.bytes, { receiverDecryptionKey: w.med.xSecret, senderSigningKey: w.peer.edPublic })
    expect([opened.messageType, opened.hops]).toEqual(['routed', [w.me.did]])
    expect(decodeEnvelope(new Uint8Array(opened.payload)).envelope).toEqual({ sender: w.peer.did, receiver: w.me.did })
  })

  it('positive list pairs are unique per socket', () => {
    const e = { sender: 'did:key:a', receiver: 'did:key:b', signing: [], receiverSecret: new Uint8Array(32), allowed: new Set(['direct'] as const) }
    expect(() => new PositiveList([e, { ...e, allowed: new Set(['control'] as const) }])).toThrow()
  })

  it('seed sweep (20 seeds): identities pass the lib gate, probe and doc classify the same way', async () => {
    for (let seed = 100; seed < 120; seed++) {
      const w = await world(seed)
      const rand = seededRand(seed + 1000)
      const root = rand(32)
      const nonce = rand(32)
      for (const scope of ['connection', 'egress'] as const) await expect(gatedWireIdentity(root, FAKE_DID, nonce, scope)).resolves.toBeTruthy()
      const payload = w.rand(64)
      const p = await w.fromPeer(payload)
      w.registry.add(record(`p${seed}`, 'probe', payload, p.bytes))
      expect((await classifyFrame(p.bytes, w.ctx)).cls, `seed ${seed}`).toBe('probe')
      const { bytes } = await sealDoc(w.peerParty, w.meParty, { seed }, `t${seed}`)
      const d = await classifyFrame((await w.fromPeer(bytes)).bytes, w.ctx)
      expect([d.cls, d.verdict], `seed ${seed}`).toEqual(['doc', 'unique'])
    }
  })
})
