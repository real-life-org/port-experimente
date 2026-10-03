import { World } from './world'
import type { Candidate } from './types'

export interface LoadResult {
  readonly runs?: number
  readonly members: number
  readonly operations: number
  readonly ms: number
  /** Laufzeit pro Autoritätsoperation inkl. Zustellung an alle Geräte. */
  readonly msPerOp: number
  readonly error?: string
}

/** Deterministischer Zufall, damit Läufe auf verschiedenen Geräten vergleichbar sind. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

/**
 * S9-Last (wasm-rust-frage-2026-08): eine Gruppe mit `members` Personen,
 * `operations` Autoritätsoperationen (Entfernen, Wiederaufnehmen, Rotation),
 * alle 50 Operationen wird zugestellt.
 */
export async function runLoad(make: () => Candidate, members = 30, operations = 500): Promise<LoadResult> {
  const candidate = make()
  const w = new World(candidate)
  const next = rng(42)
  const people = Array.from({ length: members }, (_, i) => `p${String(i).padStart(2, '0')}`)
  const t0 = performance.now()
  try {
    for (const p of people) await w.device(p, p)
    await w.createGroup('p00')
    for (const p of people.slice(1)) await w.add('p00', p)
    await w.flush()
    const inside = new Set(people)
    for (let i = 0; i < operations; i++) {
      const p = people[1 + Math.floor(next() * (members - 1))]!
      const roll = next()
      if (roll < 0.2 && candidate.capabilities.has('rotate')) await candidate.rotate('p00')
      else if (inside.has(p)) { await w.remove('p00', p); inside.delete(p) }
      else { await w.add('p00', p); inside.add(p) }
      if (i % 50 === 49) await w.flush()
    }
    await w.flush()
    const ms = performance.now() - t0
    return { members, operations, ms, msPerOp: ms / operations }
  } catch (e) {
    const ms = performance.now() - t0
    return { members, operations, ms, msPerOp: ms / operations, error: (e as Error).message }
  }
}

/**
 * Mehrere Läufe, gemeldet wird der Median. Browser runden
 * `performance.now()` teils auf ganze Millisekunden (Firefox, vermutlich
 * auch Vanadium); einzelne kurze Läufe sind dann nicht aussagekräftig.
 */
export async function runLoadMedian(make: () => Candidate, runs = 5, members = 30, operations = 500): Promise<LoadResult> {
  const results: LoadResult[] = []
  for (let i = 0; i < runs; i++) {
    const r = await runLoad(make, members, operations)
    if (r.error) return { ...r, runs: i + 1 }
    results.push(r)
  }
  results.sort((a, b) => a.ms - b.ms)
  const median = results[Math.floor(results.length / 2)]!
  return { ...median, runs }
}
