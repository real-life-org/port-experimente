import { afterAll, describe, expect, it, vi } from 'vitest'

// E11b step 3, standing bench rule (seed sweep, 19.10.): every routed cell on R-c and R-es, and the control RT1-K on
// R-ce, under 20 fixed seeds. The intermediary makes no random decision (no `CoinBranches`); its fault parameters are
// enumerated as cells of their own (T3r 5, T5r 28 per form). Chance enters through key material, nonces, UUIDs and
// HPKE, all from `crypto.getRandomValues` / `crypto.randomUUID`, seeded with the generator of
// tests/mehrgeraet-seeds.test.ts (LCG, version 1). Every seed must give: all cells passed; Z1r with 2 (R-c) and 4
// (R-es) sessions per relationship, the outer sender as in the NOTES, the inner document frame inside the step-2 range
// (Z1r), and the outer frame = inner + 384 B for every frame any intermediary forwarded in any cell of either form
// (documents, receipts, duplicates, tampered and misrouted frames). A failing seed prints its number; every
// counterexample becomes a permanent test. `SEEDS=<n>` runs the first n.

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

import { RoutedIntermediary, routedDeliveryScenarios, runRouted, type OpenedRecord } from '../src/lab/zustellung-routed'
import { tspRoutedControlWire, tspRoutedEgressSessionWire, tspRoutedWire } from '../src/candidates/zustellung/tsp-routed'

const FORMS = [
  { id: 'tsp-routed', make: tspRoutedWire, sessions: 2, outerSender: 'Konto(alice)' },
  { id: 'tsp-routed-egress-session', make: tspRoutedEgressSessionWire, sessions: 4, outerSender: 'Egress(alice)' },
]
/** The inner document range of step 2 (Z1, payload `geheim-drei`), and the outer overhead with a did:key intermediary. */
const INNER = [1491, 1494] as const
const OVERHEAD = 384
const env = process.env.SEEDS
const SEEDS = Array.from({ length: env === undefined || env === 'all' ? 20 : Math.min(20, Math.max(1, Number(env) || 20)) }, (_, i) => i + 1)
const formCells = routedDeliveryScenarios.filter((s) => s.role === 'form').length
const seen = { inner: [] as number[], outer: [] as number[], seeds: 0, cells: 0, forwarded: 0, overheads: new Set<number>() }

/**
 * Every frame every intermediary forwards, across all cells (review 1 of step 3, C-b): each instance's `opened` records
 * are collected after each opening, from the index seen last for that instance (openings run concurrently).
 */
const forwarded: OpenedRecord[] = []
const read = new WeakMap<RoutedIntermediary, number>()
type Open = (this: RoutedIntermediary, ...a: unknown[]) => Promise<void>
const proto = RoutedIntermediary.prototype as unknown as { open: Open }
const open = proto.open
vi.spyOn(proto, 'open').mockImplementation(async function (this: RoutedIntermediary, ...a: unknown[]) {
  try {
    await open.apply(this, a)
  } finally {
    const from = read.get(this) ?? 0
    forwarded.push(...this.opened.slice(from))
    read.set(this, this.opened.length)
  }
})

describe('E11b step 3 seed sweep: every seed gives the NOTES table', () => {
  for (const seed of SEEDS) {
    it(`routed seed ${String(seed).padStart(2, '0')}`, async () => {
      rng.n = seed
      const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => rng.uuid() as `${string}-${string}-${string}-${string}-${string}`)
      const values = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
        if (a) new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(rng.bytes(a.byteLength))
        return a
      })
      try {
        const diff: string[] = []
        forwarded.length = 0
        for (const f of FORMS) {
          const results = await runRouted(f.make)
          if (results.length !== formCells) diff.push(`${f.id}: ${results.length} cells, expected ${formCells}`)
          seen.cells += results.length
          for (const r of results) if (r.outcome !== 'bestanden') diff.push(`${f.id} ${r.scenario}: ${r.detail.slice(0, 400)}`)
          const z1 = results.find((r) => r.scenario === 'Z1r')?.measure ?? {}
          if (z1.sessions !== f.sessions) diff.push(`${f.id} Z1r sessions ${z1.sessions}`)
          if (z1.outerSender !== f.outerSender) diff.push(`${f.id} Z1r outer sender ${z1.outerSender}`)
          if (z1.overhead !== String(OVERHEAD)) diff.push(`${f.id} Z1r overhead ${z1.overhead}`)
          const inner = Number(z1.innerDoc)
          const outer = Number(z1.outerDoc)
          seen.inner.push(inner)
          seen.outer.push(outer)
          if (inner < INNER[0] || inner > INNER[1]) diff.push(`${f.id} Z1r inner ${inner} B outside ${INNER.join('–')}`)
          if (outer !== inner + OVERHEAD) diff.push(`${f.id} Z1r outer ${outer} ≠ inner ${inner} + ${OVERHEAD}`)
          const rt5 = results.find((r) => r.scenario === 'RT5')?.measure ?? {}
          if (rt5.sessionsI2 !== f.sessions) diff.push(`${f.id} RT5 sessions at I2 ${rt5.sessionsI2}`)
        }
        if (forwarded.length === 0) diff.push('no forwarded frame seen')
        for (const o of forwarded) {
          seen.overheads.add(o.outerBytes - o.innerBytes)
          if (o.outerBytes - o.innerBytes !== OVERHEAD) diff.push(`forwarded ${o.outerSender} → ${o.next}: outer ${o.outerBytes} ≠ inner ${o.innerBytes} + ${OVERHEAD}`)
        }
        seen.forwarded += forwarded.length
        const control = await runRouted(tspRoutedControlWire)
        seen.cells += control.length
        if (control.map((r) => `${r.scenario}:${r.outcome}`).join() !== 'RT1-K:bestanden') diff.push(`R-ce: ${JSON.stringify(control)}`)
        seen.seeds++
        expect(diff, `seed ${seed} (rng v${rng.version})`).toEqual([])
      } finally {
        uuid.mockRestore()
        values.mockRestore()
      }
    }, 600_000)
  }

  it('sizes over the sweep: inner inside the step-2 range, outer = inner + 384 B', () => {
    expect(seen.seeds).toBe(SEEDS.length)
    expect(seen.cells).toBe(SEEDS.length * (2 * formCells + 1))
    expect(Math.min(...seen.inner)).toBeGreaterThanOrEqual(INNER[0])
    expect(Math.max(...seen.inner)).toBeLessThanOrEqual(INNER[1])
    expect(Math.min(...seen.outer)).toBeGreaterThanOrEqual(INNER[0] + OVERHEAD)
    expect(Math.max(...seen.outer)).toBeLessThanOrEqual(INNER[1] + OVERHEAD)
    expect(seen.forwarded).toBeGreaterThan(0)
    expect([...seen.overheads]).toEqual([OVERHEAD])
  })
})

afterAll(() => {
  if (seen.seeds) process.stderr.write(`E11b step 3 over ${seen.seeds} seeds, ${seen.cells} cells: inner document ${Math.min(...seen.inner)}–${Math.max(...seen.inner)} B, outer ${Math.min(...seen.outer)}–${Math.max(...seen.outer)} B; ${seen.forwarded} forwarded frames, overhead ${[...seen.overheads].join('/')} B\n`)
})
