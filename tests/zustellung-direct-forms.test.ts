import { describe, expect, it } from 'vitest'
import { decodeEnvelope, pack, packInvite } from '@openvtc/vti-tsp-js'
import { HORIZON, Welt, party, runDelivery, type Wire } from '../src/lab/zustellung'
import { sessionCell } from '../src/lab/zustellung-sessions'
import { wires } from '../src/candidates/zustellung'
import { tspWire } from '../src/candidates/zustellung/tsp'
import { admitDirect, relationshipIdentities, type SessionEndpoint } from '../src/candidates/zustellung/tsp-direct'
import { tspDirectConnectionWire } from '../src/candidates/zustellung/tsp-direct-connection'
import { tspDirectEgressSessionWire, tspDirectEgressSpecWire } from '../src/candidates/zustellung/tsp-direct-egress-session'

// E11b step 2: the two direct send forms of the plan (§2) as wires of the delivery bench, next to the `tsp` reference
// wire. (b) `tsp-direct-connection`: the connection DID (the account at the carrier) is the sender. (a)
// `tsp-direct-egress-session`: an egress identity per relationship and side is the sender and holds a session of its
// own at the carrier. Both deliver to the partner's connection DID. Findings: src/candidates/zustellung/NOTES.md,
// section "E11b step 2: direct forms".

const enc = new TextEncoder()
const dec = new TextDecoder()
const ALL = { T9: 'bestanden', T10: 'bestanden', Z1: 'bestanden', Z2: 'bestanden', Z3: 'bestanden', Z4: 'bestanden', Z5: 'bestanden' }
const make = (id: string) => wires.find((w) => w.id === id)!.make
const details = async (id: string) => {
  const results = await runDelivery(make(id))
  expect(Object.fromEntries(results.map((r) => [r.scenario, r.outcome])), JSON.stringify(results, null, 1)).toEqual(ALL)
  return Object.fromEntries(results.map((r) => [r.scenario, r.detail]))
}
const has = (frame: Uint8Array, s: string) => dec.decode(frame).includes(s)

describe('E11b step 2: wires in the delivery bench', () => {
  it('both direct forms are registered next to the tsp reference wire', () => {
    expect(wires.map((w) => w.id)).toEqual(expect.arrayContaining(['tsp', 'tsp-direct-connection', 'tsp-direct-egress-session']))
  })

  it('(b) tsp-direct-connection: T9, T10, Z1–Z5; the sender in the frame is the account (connection DID)', async () => {
    const d = await details('tsp-direct-connection')
    expect(d.Z1).toContain('absender=Konto(alice)')
    expect(d.Z1).toContain('empfaenger=Konto(bob)')
    expect(d.Z1).toContain('konto=sichtbar')
    expect(d.Z4).toContain('am Draht')
    expect(d.Z5).toContain('am Draht')
  }, 120_000)

  it('(a) tsp-direct-egress-session: T9, T10, Z1–Z5; the sender in the frame is the egress pseudonym, not the account', async () => {
    const d = await details('tsp-direct-egress-session')
    expect(d.Z1).toContain('absender=Egress(alice)')
    expect(d.Z1).toContain('empfaenger=Konto(bob)')
    expect(d.Z1).toContain('konto=verdeckt')
    expect(d.Z4).toContain('am Draht')
    expect(d.Z5).toContain('am Draht')
  }, 120_000)
})

describe('E11b step 2: Z1 in the bytes (what the partner opens)', () => {
  const sendOne = async (wire: Wire) => {
    const w = new Welt(wire)
    const { A, B } = await w.pair(await party('alice'), await party('bob'))
    const d = await A.send({ note: 'z1-bytes' })
    await w.until(() => A.zusteller.report(d)?.state === 'delivered')
    const doc = w.carrier.carried.find((f) => f.address === B.endpoint.address)!.bytes
    return { A, B, doc, a: A.endpoint as SessionEndpoint, b: B.endpoint as SessionEndpoint }
  }

  it('(b): the frame sender is Alice\'s account; Alice\'s two relationships use different accounts', async () => {
    const { doc, a, b } = await sendOne(tspDirectConnectionWire())
    const e = decodeEnvelope(doc).envelope
    expect(a.sender).toBe(a.account)
    expect(e.sender).toBe(a.account)
    expect(e.receiver).toBe(b.account)
    expect(has(doc, a.account)).toBe(true)
  }, 60_000)

  it('(a): the frame never names Alice\'s account; the partner still addresses it (delivery address)', async () => {
    const { A, doc, a, b } = await sendOne(tspDirectEgressSessionWire())
    const e = decodeEnvelope(doc).envelope
    expect(a.sender).not.toBe(a.account)
    expect(e.sender).toBe(a.sender)
    expect(e.receiver).toBe(b.account)
    expect(has(doc, a.account)).toBe(false)
    // The partner delivers its receipts to Alice's account: in the direct mode it knows the account as the address.
    expect(A.endpoint.address).toBe(a.account)
  }, 60_000)

  it('identities are carrier-scoped per relationship: Alice–Bob and Alice–Carol share no DID', async () => {
    const [alice, bob, carol] = [await party('alice'), await party('bob'), await party('carol')]
    const ab = await relationshipIdentities(alice, bob)
    const ac = await relationshipIdentities(alice, carol)
    const dids = [ab.conn.did, ab.egress.did, ac.conn.did, ac.egress.did]
    expect(new Set(dids).size).toBe(4)
    expect(await relationshipIdentities(alice, bob)).toEqual(ab) // deterministic from the party and the peer
  })
})

describe('E11b step 2: parser rule (#95, MV-24): only `direct` with a payload reaches receive()', () => {
  const forms: Array<[string, () => Wire, 'conn' | 'egress']> = [
    ['tsp-direct-connection', tspDirectConnectionWire, 'conn'],
    ['tsp-direct-egress-session', tspDirectEgressSessionWire, 'egress'],
  ]
  for (const [id, wire, as] of forms) {
    it(`${id}: a control frame, an empty direct frame and misaddressed frames under the genuine partner's key are rejected at the wire`, async () => {
      const w = new Welt(wire())
      const alice = await party('alice')
      const bob = await party('bob')
      const { A, B } = await w.pair(alice, bob)
      const sa = (await relationshipIdentities(alice, bob))[as]
      const rb = (await relationshipIdentities(bob, alice)).conn
      const keys = { senderSigningKey: sa.edSecret, receiverEncryptionKey: rb.xPublic }
      const control = await packInvite(sa.did, rb.did, keys)
      const empty = await pack(new Uint8Array(0), sa.did, rb.did, keys)
      // Genuine signing key, but the envelope names another sender, or another receiver (sealed to Bob's key).
      const other = (await relationshipIdentities(alice, await party('carol'))).conn.did
      const wrongSender = await pack(enc.encode('x'), other, rb.did, keys)
      const wrongReceiver = await pack(enc.encode('x'), sa.did, other, keys)
      for (const f of [control, empty, wrongSender, wrongReceiver]) w.carrier.deposit(B.endpoint.address, f.bytes)
      await w.rounds(2)
      expect(B.received.length).toBe(0)
      const wireRejects = B.dispositions.filter((x) => x.startsWith('failed(malformed): '))
      expect(wireRejects.length, B.dispositions.join(' | ')).toBe(4)
      expect(wireRejects.filter((x) => x.includes('type control')).length).toBe(1)
      expect(wireRejects.filter((x) => x.includes('empty direct')).length).toBe(1)
      expect(wireRejects.filter((x) => x.includes('mismatch')).length).toBe(2)
      // The genuine document still goes through after the rejected frames.
      const d = await A.send({ note: 'danach' })
      await w.until(() => A.zusteller.report(d)?.state === 'delivered')
      expect(B.received.length).toBe(1)
    }, 60_000)
  }

  it('own guard (H1): a message the library reports as another revision is rejected, before sender, type or payload are looked at', () => {
    const ok = { revision: 'rev3', sender: 'did:s', receiver: 'did:r', messageType: 'direct', payload: new Uint8Array([1]) }
    expect(Array.from(admitDirect(ok, 'did:s', 'did:r'))).toEqual([1])
    expect(() => admitDirect({ ...ok, revision: 'rev2' }, 'did:s', 'did:r')).toThrow('tsp: revision rev2')
    expect(() => admitDirect({ ...ok, revision: 'rev4' }, 'did:s', 'did:r')).toThrow('tsp: revision rev4')
  })

  it('a frame declaring Rev 2 (version marker patched) is rejected at the wire, never passed on', async () => {
    const w = new Welt(tspDirectConnectionWire())
    const alice = await party('alice')
    const bob = await party('bob')
    const { B } = await w.pair(alice, bob)
    const sa = (await relationshipIdentities(alice, bob)).conn
    const rb = (await relationshipIdentities(bob, alice)).conn
    const f = (await pack(enc.encode('x'), sa.did, rb.did, { senderSigningKey: sa.edSecret, receiverEncryptionKey: rb.xPublic })).bytes.slice()
    // Version marker: `-E` count code (3 bytes short, 6 long), the 3-byte YTSP genus, then a triplet whose low 12 bits are MINOR.
    const at = (f[0] === 0xfb ? 6 : 3) + 3
    const word = ((f[at]! << 16) | (f[at + 1]! << 8) | f[at + 2]!) & ~0xfff
    const rev2 = word | 1
    f.set([(rev2 >>> 16) & 255, (rev2 >>> 8) & 255, rev2 & 255], at)
    expect(decodeEnvelope(f).revision).toBe('rev2')
    w.carrier.deposit(B.endpoint.address, f)
    await w.rounds(2)
    expect(B.received.length).toBe(0)
    expect(B.dispositions.length).toBe(1)
    expect(B.dispositions[0]).toMatch(/^failed\(malformed\): tsp: .*Rev 2/)
  }, 60_000)
})

/**
 * Sessions at the carrier: a carrier that forwards a frame only if the depositing device holds a session for its
 * envelope sender, i.e. the sender is the identity of the socket it comes in on (the live situation of 17 and 21
 * October: the VTI mediator drops the spec form, egress over the connection socket, silently).
 */
describe('E11b step 2: sessions per relationship under the session rule', () => {
  const run = sessionCell

  it('tsp reference: one registration per side, delivered', async () => {
    const r = await run(tspWire())
    expect(r).toMatchObject({ delivered: true, sessions: 2, refused: 0 })
  }, 60_000)

  it('(b) connection: one session per side (2 per relationship), delivered', async () => {
    const r = await run(tspDirectConnectionWire())
    expect(r).toMatchObject({ delivered: true, sessions: 2, refused: 0 })
  }, 60_000)

  it('(a) egress-session: two sessions per side (4 per relationship), delivered', async () => {
    const r = await run(tspDirectEgressSessionWire())
    expect(r).toMatchObject({ delivered: true, sessions: 4, refused: 0 })
  }, 60_000)

  it('control, spec form (egress without a session of its own): dropped silently at the carrier; the sender reports, never silent', async () => {
    const r = await run(tspDirectEgressSpecWire(), HORIZON.giveUp + 2)
    expect(r.delivered).toBe(false)
    expect(r.report).toBe('failed(expired-by-adapter-policy)')
    expect(r.sessions).toBe(2)
    expect(r.refused).toBeGreaterThanOrEqual(2) // first deposit and at least one repetition
    expect(r.receiverSaw).toEqual([]) // nothing reached Bob: the drop is at the carrier, not at the wire
  }, 60_000)

  it('control (C1): sessions of the egress identities held by foreign devices do not carry the spec form; the depositing device must hold the sender', async () => {
    const r = await run(tspDirectEgressSpecWire(), HORIZON.giveUp + 2, (carrier, A, B) => {
      carrier.register('fremd-1', (A.endpoint as SessionEndpoint).sender)
      carrier.register('fremd-2', (B.endpoint as SessionEndpoint).sender)
    })
    expect(r.delivered).toBe(false)
    expect(r.report).toBe('failed(expired-by-adapter-policy)')
    expect(r.refused).toBeGreaterThanOrEqual(2)
    expect(r.receiverSaw).toEqual([])
  }, 60_000)

  it('without the rule (default carrier) the spec form would pass: the rule is what the control measures', async () => {
    const w = new Welt(tspDirectEgressSpecWire())
    const { A } = await w.pair(await party('alice'), await party('bob'))
    const d = await A.send({ note: 'ohne-regel' })
    expect(await w.until(() => A.zusteller.report(d)?.state === 'delivered')).toBeGreaterThan(0)
  }, 60_000)

  it('same frame size for the same payload in all three direct wires (same VID kind, same frame layout)', async () => {
    // Sealed documents vary by a few bytes (base58 proof values) and CESR aligns to quadlets, so the wires are compared
    // on identical payloads of three lengths (every residue mod 3).
    const sizes = async (wire: Wire) => {
      const e = await wire.bind(await party('alice'), await party('bob'))
      return Promise.all([1000, 1001, 1002].map(async (n) => (await e.b.pack(new Uint8Array(n).fill(7))).length))
    }
    const rows = [await sizes(tspWire()), await sizes(tspDirectConnectionWire()), await sizes(tspDirectEgressSessionWire())]
    expect(rows[1]).toEqual(rows[0])
    expect(rows[2]).toEqual(rows[0])
  }, 60_000)
})

