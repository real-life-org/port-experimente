// E15 K2 step 2b.0: the minimal event generator (design 2b draft 2 §5.3, §5.4; draft 3 §8 "2b.0"). Seeded random event
// sequences over the existing step-2a paths (holder, carrier, deliverer, store) with M as single-writer fixture
// (`bench.singleDevice: ['M']`): introduce(m), rounds, reorder / duplicate / drop / delay delivery per address, lost or
// delayed receipts, crashes at `before-commit`, `before-send` (after the commit), `between-sends` (between the two tickets)
// and `after-commit` of a round (at a side: after the acceptance, before the receipt), time advance. No restores (2b.0;
// the one fixed restore sequence, D1, is a test). The outcome ledger (`buch.ts`) observes; the checkers judge. On a failed
// property the sequence is shrunk (§5.4): blocks, then single events are dropped while the same property still fails.

import type { CrashPoint } from '../zustellung'
import type { HolderDevice, MultiDeviceCandidate } from './holder'
import { ledgerWorld, pCommit, pEinmal, pGueltig, pPaar, pProduktion, pairCounter, PRODUCTION, type Buch, type Check } from './buch'
import type { Welt15 } from './welt'

export type GenEvent =
  | { k: 'round' }
  | { k: 'introduce'; crash?: Extract<CrashPoint, 'before-commit' | 'before-send' | 'between-sends'> }
  | { k: 'reverse' }
  | { k: 'duplicate' }
  | { k: 'drop'; device: string }
  | { k: 'delay'; device: string }
  | { k: 'drop-acks' }
  | { k: 'delay-acks' }
  | { k: 'crash'; device: string; point: Extract<CrashPoint, 'before-commit' | 'after-commit'> }
  | { k: 'advance'; ms: number }
  | { k: 'consent'; device: string }

/** Versioned generator (mulberry32); a seed always gives the same sequence. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Devices of the generator world: A and B with two devices, M one (single-writer fixture). */
export const DEVICES = ['A1', 'A2', 'B1', 'B2', 'M1'] as const
const SIDES = ['A1', 'A2', 'B1', 'B2'] as const

export function generate(seed: number, length: number): GenEvent[] {
  const r = prng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const out: GenEvent[] = []
  for (let i = 0; i < length; i++) {
    const x = r()
    if (x < 0.25) out.push({ k: 'round' })
    else if (x < 0.45) out.push(r() < 0.6 ? { k: 'introduce' } : { k: 'introduce', crash: pick(['before-commit', 'before-send', 'between-sends'] as const) })
    else if (x < 0.5) out.push({ k: 'reverse' })
    else if (x < 0.55) out.push({ k: 'duplicate' })
    else if (x < 0.62) out.push({ k: 'drop', device: pick(DEVICES) })
    else if (x < 0.69) out.push({ k: 'delay', device: pick(DEVICES) })
    else if (x < 0.74) out.push({ k: 'drop-acks' })
    else if (x < 0.79) out.push({ k: 'delay-acks' })
    else if (x < 0.88) out.push({ k: 'crash', device: pick(DEVICES), point: pick(['before-commit', 'after-commit'] as const) })
    else if (x < 0.95) out.push({ k: 'consent', device: pick(SIDES) })
    else out.push({ k: 'advance', ms: Math.floor(r() * 12) * 3600_000 })
  }
  return out
}

export const show = (e: GenEvent) => (e.k === 'introduce' ? `introduce${e.crash ? `@${e.crash}` : ''}` : e.k === 'crash' ? `crash ${e.device}@${e.point}` : e.k === 'drop' || e.k === 'delay' || e.k === 'consent' ? `${e.k} ${e.device}` : e.k === 'advance' ? `advance ${e.ms / 3600_000}h` : e.k)

export interface GenWorld {
  w: Welt15
  buch: Buch
  A: HolderDevice
  B: HolderDevice
  Mm: HolderDevice
  /** M's relationship ids to A and B, and the addresses (M's tuple keys) revisions of each side arrive at. */
  ma: string
  mb: string
  addrA: string[]
  addrB: string[]
}

/** The world of draft 2 §5.3 for 2b.0: A, B with two devices each, M as one device (fixture), class on, stock at M. */
export async function genWorld(candidate: MultiDeviceCandidate): Promise<GenWorld> {
  const { w, buch } = ledgerWorld(candidate)
  const A = await w.person('A', 'A1')
  const B = await w.person('B', 'B1')
  const Mm = await w.person('M', 'M1')
  const am = await w.encounter(A, Mm)
  const bm = await w.encounter(B, Mm)
  await w.rounds(2)
  await A.setClass(am.x.id, true)
  await B.setClass(bm.x.id, true)
  await w.rounds(3)
  await w.enrol(A, 'A2')
  await w.enrol(B, 'B2')
  if (!candidate.bench?.singleDevice?.includes('M')) throw new Error('2b.0 generator: M must be a single-writer fixture (bench.singleDevice)')
  await w.rounds(2)
  const addr = async (rel: string) => Promise.all(M_tuples(Mm, rel).map(async (ctx) => (await Mm.cand.keys.pair(ctx)).rkid))
  return { w, buch, A, B, Mm, ma: am.y.id, mb: bm.y.id, addrA: await addr(am.y.id), addrB: await addr(bm.y.id) }
}
function M_tuples(d: HolderDevice, rel: string): string[] {
  const r = d.state.relationships.find((x) => x.id === rel || x.tuples.some((t) => t.id === rel))
  return r ? r.tuples.map((t) => t.ownKey) : []
}

/** Test-only mutation: applied to the generator world after setup (never a flag in the code under test). */
export type Mutation = (g: GenWorld) => void

export interface GenRun {
  seed: number
  events: GenEvent[]
  checks: Check[]
  counter: ReturnType<typeof pairCounter>
  buch: Buch
}

/**
 * One run: a fresh world, the events, then a drain of plain rounds so every production obligation is decidable. A down
 * device (crashed) is rebuilt from its store before the next round (crash, restart from the last commit; no restore).
 */
export async function runSequence(candidate: () => MultiDeviceCandidate, events: GenEvent[], opts: { seed?: number; reseed?: (seed: number) => void; mutation?: Mutation; drain?: number } = {}): Promise<GenRun> {
  const seed = opts.seed ?? 0
  opts.reseed?.(seed)
  const g = await genWorld(candidate())
  opts.mutation?.(g)
  const { w, buch } = g
  const down = new Set<string>()
  const crashCount = new Map<string, number>()
  const dev = (name: string) => w.devices.find((d) => d.name === name)
  const detect = () => {
    for (const d of w.devices) {
      const n = d.crashes.length
      if (n > (crashCount.get(d.name) ?? 0)) {
        crashCount.set(d.name, n)
        down.add(d.name)
        buch.note('crashed', d.name, { point: d.crashes[n - 1] })
      }
    }
  }
  const restart = async () => {
    for (const name of [...down]) {
      down.delete(name)
      await dev(name)!.reload()
      buch.note('reload', name)
    }
  }
  const round = async () => {
    await restart()
    await w.rounds(1)
    detect()
    buch.note('round', undefined, { up: w.devices.filter((d) => d.online && !down.has(d.name)).map((d) => d.name) })
  }
  const faulted = async (apply: () => void, what: string) => {
    buch.note('fault', undefined, { what })
    apply()
    try {
      await round()
    } finally {
      w.carrier.faults.reset()
    }
  }
  const selves = (name: string) => (f: { address: string }) => w.carrier.registeredAt(f.address).includes(name)
  const isAck = (f: { bytes: Uint8Array }) => w.frameOrigin(f.bytes)?.kind === 'delivery-ack'
  for (const e of events) {
    switch (e.k) {
      case 'round':
        await round()
        break
      case 'introduce': {
        const m = g.Mm
        const up = !down.has(m.name) && m.online
        // Noted before the call: the reference model reads the ledger up to this point, the issuance's commit follows it.
        const detail: Record<string, unknown> = { addrA: g.addrA, addrB: g.addrB, result: null, armed: e.crash ?? null, up }
        buch.note('introduce', m.name, detail)
        if (e.crash) m.crashAt = e.crash
        detail.result = await m.introduce(g.ma, g.mb)
        m.crashAt = null // targeted: an unused crash point does not fire later
        detect()
        break
      }
      case 'consent': {
        // A side device agrees to the first act it holds as offered (8325.A4); nothing if none or the device is down.
        const d = dev(e.device)
        const a = d && !down.has(d.name) ? d.state.acts.find((x) => x.state === 'offered') : undefined
        if (d && a) {
          buch.note('consent', d.name, { act: a.id })
          await d.consent(a.id)
          detect()
        }
        break
      }
      case 'reverse':
        await faulted(() => w.carrier.faults.reverse(true), 'reverse')
        break
      case 'duplicate':
        await faulted(() => w.carrier.faults.duplicate(true), 'duplicate')
        break
      case 'drop':
        await faulted(() => w.carrier.faults.drop(selves(e.device)), `drop ${e.device}`)
        break
      case 'delay':
        await faulted(() => w.carrier.faults.withhold(e.device, () => true), `delay ${e.device}`)
        break
      case 'drop-acks':
        await faulted(() => w.carrier.faults.drop(isAck), 'drop-acks')
        break
      case 'delay-acks':
        await faulted(() => {
          for (const d of w.devices) w.carrier.faults.withhold(d.name, isAck)
        }, 'delay-acks')
        break
      case 'crash': {
        const d = dev(e.device)
        if (d && !down.has(d.name)) d.crashAt = e.point
        await round()
        if (d) d.crashAt = null
        break
      }
      case 'advance':
        w.clock.advance(e.ms)
        buch.note('advance', undefined, { ms: e.ms })
        break
    }
  }
  for (let i = 0; i < (opts.drain ?? PRODUCTION.rounds + 3); i++) await round()
  // Issue #83: P-Gueltig first; on an invalid run the four property checkers are not green either, so the generator, G1
  // and shrinking treat it as a failure (seed and errors printed).
  const checks = [pGueltig(buch), pEinmal(buch), await pCommit(buch), await pProduktion(buch), pPaar(buch)]
  return { seed, events, checks, counter: pairCounter(buch), buch }
}

const fails = (r: GenRun, property: Check['property']) => !r.checks.find((c) => c.property === property)!.ok

/**
 * Shrinking (draft 2 §5.4): drop blocks (halves, quarters, …) and then single events while the same property still fails;
 * returns the smallest failing sequence found and the number of runs it took.
 */
export async function shrink(candidate: () => MultiDeviceCandidate, events: GenEvent[], property: Check['property'], opts: { seed?: number; reseed?: (seed: number) => void; mutation?: Mutation; maxRuns?: number } = {}): Promise<{ events: GenEvent[]; runs: number }> {
  let cur = events
  let runs = 0
  const max = opts.maxRuns ?? 200
  for (let size = Math.max(1, Math.floor(cur.length / 2)); size >= 1 && runs < max; size = size === 1 ? 0 : Math.max(1, Math.floor(size / 2))) {
    let i = 0
    while (i < cur.length && runs < max) {
      const cand = [...cur.slice(0, i), ...cur.slice(i + size)]
      runs++
      if (fails(await runSequence(candidate, cand, opts), property)) cur = cand
      else i += size
    }
  }
  return { events: cur, runs }
}

/** A failure report: seed, property, the minimal sequence (printed by the test). */
export function report(seed: number, property: string, events: GenEvent[], violations: string[]): string {
  return `seed ${seed}, ${property} fails; minimal sequence (${events.length}): [${events.map(show).join(', ')}]\n  ${violations.join('\n  ')}`
}
