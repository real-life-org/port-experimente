import { describe, expect, it, vi } from 'vitest'

// E11b step 2, standing bench rule (seed sweep, 19.10.): the delivery cells of the TSP direct wires under 20 fixed
// seeds. The wires make no random decision (no `CoinBranches`, nothing to enumerate in `src/lab/zweige.ts`); chance
// enters through key material, nonces, UUIDs and HPKE, all from `crypto.getRandomValues` / `crypto.randomUUID`, seeded
// here with the generator of tests/mehrgeraet-seeds.test.ts (LCG, version 1). Every seed must give the NOTES table:
// T9, T10, Z1–Z5 passed on all three wires with the Z1 and Z4/Z5 findings, and under the session rule (b) and (a)
// delivered with 2 and 4 sessions, the spec form dropped and reported. A failing seed prints its number; every
// counterexample becomes a permanent test. All 20 seeds run by default (≈ 17 s); `SEEDS=<n>` runs the first n.

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

import { HORIZON, runDelivery } from '../src/lab/zustellung'
import { sessionCell } from '../src/lab/zustellung-sessions'
import { tspWire } from '../src/candidates/zustellung/tsp'
import { tspDirectConnectionWire } from '../src/candidates/zustellung/tsp-direct-connection'
import { tspDirectEgressSessionWire, tspDirectEgressSpecWire } from '../src/candidates/zustellung/tsp-direct-egress-session'

const WIRES = [
  { id: 'tsp', make: tspWire, z1: ['absender=VID(alice)'] },
  { id: 'tsp-direct-connection', make: tspDirectConnectionWire, z1: ['absender=Konto(alice)', 'konto=sichtbar'] },
  { id: 'tsp-direct-egress-session', make: tspDirectEgressSessionWire, z1: ['absender=Egress(alice)', 'konto=verdeckt'] },
]
const env = process.env.SEEDS
const SEEDS = Array.from({ length: env === undefined || env === 'all' ? 20 : Math.min(20, Math.max(1, Number(env) || 20)) }, (_, i) => i + 1)

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
        for (const w of WIRES) {
          const results = await runDelivery(w.make)
          for (const r of results) if (r.outcome !== 'bestanden') diff.push(`${w.id} ${r.scenario}: ${r.outcome} (${r.detail.slice(0, 300)})`)
          const d = Object.fromEntries(results.map((r) => [r.scenario, r.detail]))
          for (const z of w.z1) if (!d.Z1?.includes(z)) diff.push(`${w.id} Z1 lacks ${z}: ${d.Z1}`)
          for (const z of ['Z4', 'Z5']) if (!d[z]?.includes('am Draht')) diff.push(`${w.id} ${z} not at the wire: ${d[z]}`)
        }
        const cells = {
          connection: await sessionCell(tspDirectConnectionWire()),
          egressSession: await sessionCell(tspDirectEgressSessionWire()),
          spec: await sessionCell(tspDirectEgressSpecWire(), HORIZON.giveUp + 2),
        }
        const got = Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, { delivered: c.delivered, report: c.report, sessions: c.sessions, refused: c.refused > 0, receiverSaw: c.receiverSaw.length }]))
        expect(got).toEqual({
          connection: { delivered: true, report: 'delivered', sessions: 2, refused: false, receiverSaw: 1 },
          egressSession: { delivered: true, report: 'delivered', sessions: 4, refused: false, receiverSaw: 1 },
          spec: { delivered: false, report: 'failed(expired-by-adapter-policy)', sessions: 2, refused: true, receiverSaw: 0 },
        })
        expect(diff, `seed ${seed} (rng v${rng.version})`).toEqual([])
      } finally {
        uuid.mockRestore()
        values.mockRestore()
      }
    }, 600_000)
  }
})
