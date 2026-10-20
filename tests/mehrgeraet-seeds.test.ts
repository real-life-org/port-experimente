import { describe, expect, it, vi } from 'vitest'

// E15 standing bench rule (review 33 S3, Anton 19.10.): the X15 matrix under 20 fixed seeds per cell and variant (K2-strict,
// K1a; K2-shared left with step 2a). Every random source is seeded: `randomBytes` and `randomUUID` from node:crypto (module mock) and the
// global `crypto.randomUUID` / `crypto.getRandomValues` (spies), one versioned generator (LCG, constants below, version 1).
// Each seed must give exactly the outcome table of the NOTES (K2: step 2 "Results"; K1a: its NOTES); a failing seed prints
// its number, and every counterexample found becomes a permanent test (none found so far).
//
// Runtime: one seed of one variant runs the whole matrix (≈ 35 s). The default run takes seed 1 of each variant; the full
// sweep (20 seeds × 2 variants) runs with `SEEDS=all` (or `SEEDS=<n>` for the first n seeds), like
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

type Cell = 'bestanden' | 'nicht bestanden' | 'nicht abbildbar'
type Expected = Record<string, { o: Cell; pc?: true }>
const ok = { o: 'bestanden' } as const
const changed = { o: 'bestanden', pc: true } as const
const red = { o: 'nicht bestanden' } as const
const na = { o: 'nicht abbildbar' } as const
const CELLS = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X7b', 'X8', 'X9', 'X10', 'X11', 'X12', 'X13', 'X14', 'X15', 'X16', 'X17', 'X18', 'X21']
const table = (special: Expected): Expected => Object.fromEntries(CELLS.map((x) => [x, special[x] ?? ok]))
/**
 * K2 NOTES, step 2a "Results": 16/3/1, ≈ X3, X9, X13, X18; red X7 strict, X14 (distributed mediator, not accepted in 2a),
 * X21 (restore artefact, MV-6 new); X10 n/a.
 */
const K2: Expected = table({ X3: changed, X7: red, X9: changed, X10: na, X13: changed, X14: red, X18: changed, X21: red })
/** K1a NOTES: 17/2/1, ≈ X3, X18; red X7, X9; X10 n/a. */
const K1A: Expected = table({ X3: changed, X7: red, X9: red, X10: na, X18: changed })

const VARIANTS: Array<{ name: string; make: () => MultiDeviceCandidate; expected: Expected }> = [
  { name: 'k2-strict', make: () => k2(), expected: K2 },
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
