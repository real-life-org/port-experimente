import { describe, expect, it, vi } from 'vitest'

// E15 standing bench rule (review 33 S3, Anton 19.10.): the X15 matrix under 20 fixed seeds per cell and variant (K2-strict,
// K2-shared, K1a). Every random source is seeded: `randomBytes` and `randomUUID` from node:crypto (module mock) and the
// global `crypto.randomUUID` / `crypto.getRandomValues` (spies), one versioned generator (LCG, constants below, version 1).
// Each seed must give exactly the outcome table of the NOTES (K2: step 2 "Results"; K1a: its NOTES); a failing seed prints
// its number, and every counterexample found becomes a permanent test (none found so far).
//
// Runtime: one seed of one variant runs the whole matrix (≈ 35 s). The default run takes seed 1 of each variant; the full
// sweep (20 seeds × 3 variants, ≈ 35 min on one core) runs with `SEEDS=all` (or `SEEDS=<n>` for the first n seeds), like
// `REPORT=1` for the report. Shard with `-t '<variant> seed <nn>'`.

const rng = vi.hoisted(() => ({
  version: 1,
  n: 1,
  bytes(size: number): Buffer {
    const b = Buffer.alloc(size)
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
    const h = b.toString('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  },
}))
vi.mock('node:crypto', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:crypto')>()), randomBytes: (n: number) => rng.bytes(n), randomUUID: () => rng.uuid() }))

import { runX15 } from '../src/lab/mehrgeraet/scenarios'
import { k2 } from '../src/candidates/mehrgeraet-k2'
import { k1a } from '../src/candidates/mehrgeraet-k1a'
import type { MultiDeviceCandidate } from '../src/lab/mehrgeraet/holder'
import { timeModel } from '../src/lab/mehrgeraet/geraetemengen'
import * as M from '../src/lab/mehrgeraet/model'

type Cell = 'bestanden' | 'nicht bestanden' | 'nicht abbildbar'
type Expected = Record<string, { o: Cell; pc?: true }>
const ok = { o: 'bestanden' } as const
const changed = { o: 'bestanden', pc: true } as const
const red = { o: 'nicht bestanden' } as const
const na = { o: 'nicht abbildbar' } as const
const CELLS = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X7b', 'X8', 'X9', 'X10', 'X11', 'X12', 'X13', 'X14', 'X15', 'X16', 'X17', 'X18', 'X21']
const table = (special: Expected): Expected => Object.fromEntries(CELLS.map((x) => [x, special[x] ?? ok]))
/** K2 NOTES, step 2 "Results": 18/1/1, ≈ X3, X9, X13, X18; red X7 strict; X10 n/a. */
const K2: Expected = table({ X3: changed, X7: red, X9: changed, X10: na, X13: changed, X18: changed })
/** K1a NOTES: 17/2/1, ≈ X3, X18; red X7, X9; X10 n/a. */
const K1A: Expected = table({ X3: changed, X7: red, X9: red, X10: na, X18: changed })

const VARIANTS: Array<{ name: string; make: () => MultiDeviceCandidate; expected: Expected }> = [
  { name: 'k2-strict', make: () => k2({ stock: 'strict' }), expected: K2 },
  { name: 'k2-shared', make: () => k2({ stock: 'shared' }), expected: K2 },
  { name: 'k1a', make: () => k1a(), expected: K1A },
]
const env = process.env.SEEDS
const SEEDS = Array.from({ length: env === undefined ? 1 : env === 'all' ? 20 : Math.min(20, Math.max(1, Number(env) || 20)) }, (_, i) => i + 1)

describe('E15 seed sweep (review 33 S3): every seed gives the NOTES table', () => {
  for (const v of VARIANTS) {
    for (const seed of SEEDS) {
      it(`${v.name} seed ${String(seed).padStart(2, '0')}`, async () => {
        rng.n = seed
        const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => rng.uuid() as `${string}-${string}-${string}-${string}-${string}`)
        const values = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
          if (a) new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(rng.bytes(a.byteLength))
          return a
        })
        try {
          const got = await runX15(v.make())
          const seen = Object.fromEntries(got.map((r) => [r.scenario, { o: r.outcome, ...(r.promiseChanged ? { pc: true } : {}), ...(r.crashed ? { crashed: true } : {}) }]))
          const diff = CELLS.filter((x) => JSON.stringify(seen[x]) !== JSON.stringify(v.expected[x])).map((x) => `${x}: ${JSON.stringify(seen[x])} ≠ ${JSON.stringify(v.expected[x])} (${got.find((r) => r.scenario === x)?.detail.slice(0, 300)})`)
          expect(diff, `${v.name} seed ${seed} (rng v${rng.version})`).toEqual([])
        } finally {
          uuid.mockRestore()
          values.mockRestore()
        }
      }, 600_000)
    }
  }
})

// Review 34 S4: X23 took the production time from the next observation (the step after), so a card produced right at the
// acceptance end counted as "never produced". Astra's counter-run (shared, seeds 2, 3, 5, 2 days, A2 asleep days 0–8, window
// 30 days): the production time now comes from the journal (the op that produced the card); C's side is measured on its
// own (card received at, refused with which reason, act expired at). Review 37 B8: the anchor cycle derives other stock
// anchors, so under seeds 2 and 5 M's first pick is no longer a key of the sleeping A2 and nothing is lost (no case to
// check); seed 3 still reproduces it, as do 6 and 11 (of seeds 1–20: 3, 6, 11, 13, 16, 17, 19, 20).
describe('X23 evidence from the journal (review 34 S4)', () => {
  for (const seed of [3, 6, 11]) {
    it(`shared seed ${seed}: a loss counts as "card never produced" only if no device journal holds the production; a card produced in time but refused at C names C's reason`, async () => {
      rng.n = seed
      const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => rng.uuid() as `${string}-${string}-${string}-${string}-${string}`)
      const values = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
        if (a) new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(rng.bytes(a.byteLength))
        return a
      })
      try {
        let produced = new Map<string, number>()
        const r = await timeModel((o) => k2({ stock: 'shared', ...o }), {
          lifetimeDays: 30,
          days: 2,
          dormant: [[0, 8]],
          inspect: (w) => {
            // Independent of timeModel: the production ops in every A device's journal, earliest `at` per act.
            produced = new Map()
            for (const d of w.of('A')) for (const b of (d.cand as unknown as { journal(): Array<{ ops: M.Op[] }> }).journal()) for (const o of b.ops) if (o.kind === 'produce') produced.set(o.act.slice(0, 8), Math.min(produced.get(o.act.slice(0, 8)) ?? Infinity, Date.parse(o.at)))
          },
        })
        expect(r.losses.length).toBe(r.issued - r.connected)
        // Astra's case: the card is produced at the acceptance end (A2 back on day 8) and reaches C after it.
        expect(r.causes['card-late-8110.5'] ?? 0, JSON.stringify(r.losses)).toBeGreaterThan(0)
        for (const l of r.losses) {
          const what = JSON.stringify(l)
          if (l.cause === 'card-not-produced-8110.5') expect(produced.has(l.act), what).toBe(false)
          if (produced.has(l.act)) {
            expect(l.producedDay, what).not.toBeNull()
            expect(l.producedDay!, what).toBeLessThanOrEqual(l.expiresDay)
          }
          if (l.cause === 'card-late-8110.5') {
            expect(l.cardReceivedDay, what).not.toBeNull()
            expect(l.cardRefusal, what).toBe('after-acceptance-end-8110.5')
          }
        }
      } finally {
        uuid.mockRestore()
        values.mockRestore()
      }
    }, 600_000)
  }
})
