import { afterAll, describe, expect, it, vi } from 'vitest'

// E11b step 2, standing bench rule (seed sweep, 19.10.): the delivery cells of the TSP direct wires under 20 fixed
// seeds. The wires make no random decision (no `CoinBranches`, nothing to enumerate in `src/lab/zweige.ts`); chance
// enters through key material, nonces, UUIDs and HPKE, all from `crypto.getRandomValues` / `crypto.randomUUID`, seeded
// here with the generator of tests/mehrgeraet-seeds.test.ts (LCG, version 1). Every seed must give the NOTES table:
// T9, T10, Z1–Z5 passed on all three wires with the Z1 and Z4/Z5 findings; under the session rule `tsp`, (b) and (a)
// delivered with 2, 2 and 4 sessions, the spec form dropped and reported; the frame sizes inside the NOTES ranges (Z1
// document, session-cell document and receipt); and the same frame size on all three wires for the same payload.
// The last test checks min and max of the sizes over the seeds run. A failing seed prints its number; every
// counterexample becomes a permanent test. All 20 seeds run by default; `SEEDS=<n>` runs the first n.

const rng = vi.hoisted(() => ({
  version: 1,
  n: 1,
  bytes(size: number): Uint8Array {
    const b = new Uint8Array(size)
    for (let i = 0; i < size; i++) {
      this.n = (Math.imul(this.n, 1664525) + 1013904223) >>> 0
      b[i] = this.n >>> 24
    }
    return b
  },
  uuid(): string {
    const b = this.bytes(16)
    b[6] = (b[6]! & 15) | 64
    b[8] = (b[8]! & 63) | 128
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  },
}))

import { HORIZON, party, runDelivery, type Wire } from '../src/lab/zustellung'
import { sessionCell } from '../src/lab/zustellung-sessions'
import { tspWire } from '../src/candidates/zustellung/tsp'
import { tspDirectConnectionWire } from '../src/candidates/zustellung/tsp-direct-connection'
import { tspDirectEgressSessionWire, tspDirectEgressSpecWire } from '../src/candidates/zustellung/tsp-direct-egress-session'

const WIRES = [
  { id: 'tsp', make: tspWire, z1: ['absender=VID(alice)'] },
  { id: 'tsp-direct-connection', make: tspDirectConnectionWire, z1: ['absender=Konto(alice)', 'konto=sichtbar'] },
  { id: 'tsp-direct-egress-session', make: tspDirectEgressSessionWire, z1: ['absender=Egress(alice)', 'konto=verdeckt'] },
]
/** The size ranges of the NOTES table (bytes, inclusive). */
const RANGE = { z1: [1491, 1494], doc: [1485, 1488], ack: [1560, 1563] } as const
const env = process.env.SEEDS
const SEEDS = Array.from({ length: env === undefined || env === 'all' ? 20 : Math.min(20, Math.max(1, Number(env) || 20)) }, (_, i) => i + 1)

/** Sizes seen over the sweep, per kind: checked per seed against RANGE and over all seeds in the last test. */
const seen = { z1: [] as number[], doc: [] as number[], ack: [] as number[], seeds: 0 }
const within = (kind: keyof typeof RANGE, n: number) => n >= RANGE[kind][0] && n <= RANGE[kind][1]
/** Frame sizes of one wire for identical payloads of three lengths (every residue mod 3, CESR quadlets). */
const sameSize = async (wire: Wire) => {
  const e = await wire.bind(await party('alice'), await party('bob'))
  return Promise.all([1000, 1001, 1002].map(async (n) => (await e.b.pack(new Uint8Array(n).fill(7))).length))
}

describe('E11b step 2 seed sweep: every seed gives the NOTES table', () => {
  for (const seed of SEEDS) {
    it(`direct forms seed ${String(seed).padStart(2, '0')}`, async () => {
      rng.n = seed
      const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => rng.uuid() as `${string}-${string}-${string}-${string}-${string}`)
      const values = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
        if (a) new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(rng.bytes(a.byteLength))
        return a
      })
      try {
        const diff: string[] = []
        const size = (kind: keyof typeof RANGE, what: string, n: number) => {
          seen[kind].push(n)
          if (!within(kind, n)) diff.push(`${what}: ${n} B outside ${RANGE[kind].join('–')} B\n`)
        }
        for (const w of WIRES) {
          const results = await runDelivery(w.make)
          for (const r of results) if (r.outcome !== 'bestanden') diff.push(`${w.id} ${r.scenario}: ${r.outcome} (${r.detail.slice(0, 300)})`)
          const d = Object.fromEntries(results.map((r) => [r.scenario, r.detail]))
          for (const z of w.z1) if (!d.Z1?.includes(z)) diff.push(`${w.id} Z1 lacks ${z}: ${d.Z1}`)
          for (const z of ['Z4', 'Z5']) if (!d[z]?.includes('am Draht')) diff.push(`${w.id} ${z} not at the wire: ${d[z]}`)
          const z1 = /^Rahmen (\d+) B/.exec(d.Z1 ?? '')
          if (z1) size('z1', `${w.id} Z1 document`, Number(z1[1]))
          else diff.push(`${w.id} Z1 without a frame size: ${d.Z1}`)
        }
        const cells = {
          tsp: await sessionCell(tspWire()),
          connection: await sessionCell(tspDirectConnectionWire()),
          egressSession: await sessionCell(tspDirectEgressSessionWire()),
          spec: await sessionCell(tspDirectEgressSpecWire(), HORIZON.giveUp + 2),
        }
        for (const [k, c] of Object.entries(cells)) {
          size('doc', `${k} session-cell document`, c.docBytes)
          if (k !== 'spec') size('ack', `${k} session-cell receipt`, c.ackBytes)
          else if (c.ackBytes !== 0) diff.push(`spec receipt carried: ${c.ackBytes} B\n`)
        }
        const got = Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, { delivered: c.delivered, report: c.report, sessions: c.sessions, refused: c.refused > 0, receiverSaw: c.receiverSaw.length }]))
        expect(got).toEqual({
          tsp: { delivered: true, report: 'delivered', sessions: 2, refused: false, receiverSaw: 1 },
          connection: { delivered: true, report: 'delivered', sessions: 2, refused: false, receiverSaw: 1 },
          egressSession: { delivered: true, report: 'delivered', sessions: 4, refused: false, receiverSaw: 1 },
          spec: { delivered: false, report: 'failed(expired-by-adapter-policy)', sessions: 2, refused: true, receiverSaw: 0 },
        })
        const rows = await Promise.all(WIRES.map((w) => sameSize(w.make())))
        for (const [i, r] of rows.entries()) if (r.join() !== rows[0]!.join()) diff.push(`${WIRES[i]!.id} frame sizes ${r.join('/')} ≠ tsp ${rows[0]!.join('/')} for the same payloads`)
        seen.seeds++
        expect(diff, `seed ${seed} (rng v${rng.version})`).toEqual([])
      } finally {
        uuid.mockRestore()
        values.mockRestore()
      }
    }, 600_000)
  }

  it('sizes over the sweep: min and max per kind inside the NOTES ranges', () => {
    expect(seen.seeds).toBe(SEEDS.length)
    const span = Object.fromEntries((['z1', 'doc', 'ack'] as const).map((k) => [k, [Math.min(...seen[k]), Math.max(...seen[k])]]))
    expect(seen.z1.length).toBe(3 * SEEDS.length)
    expect(seen.doc.length).toBe(4 * SEEDS.length)
    expect(seen.ack.length).toBe(3 * SEEDS.length)
    for (const k of ['z1', 'doc', 'ack'] as const) expect(within(k, span[k]![0]!) && within(k, span[k]![1]!), `${k}: ${span[k]!.join('–')} B`).toBe(true)
  })
})

afterAll(() => {
  if (seen.seeds) process.stderr.write(`E11b step 2 sizes over ${seen.seeds} seeds: Z1 ${Math.min(...seen.z1)}–${Math.max(...seen.z1)} B, session document ${Math.min(...seen.doc)}–${Math.max(...seen.doc)} B, receipt ${Math.min(...seen.ack)}–${Math.max(...seen.ack)} B\n`)
})
