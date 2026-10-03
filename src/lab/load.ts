import { World } from './world'
import type { Candidate } from './types'

export interface LoadResult {
  readonly runs?: number
  readonly members: number
  readonly operations: number
  readonly ms: number
  /** Laufzeit pro Autoritätsoperation inkl. Zustellung an alle Geräte. */
  readonly msPerOp: number
  /** Nur bei eigenem Transport: davon Wartezeit beim Abfragen (Relay-Debounce, Ruhe-Erkennung). */
  readonly idleMs?: number
  /** Nur S9b: Zeit je Gerät und empfangener Nachricht. */
  readonly msPerDelivery?: number
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
    await w.flush() // Geräte machen sich bekannt (Key-Bundles), bevor eingeladen wird
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
    const idleMs = candidate.transport?.idleMs()
    return { members, operations, ms, msPerOp: ms / operations, ...(idleMs === undefined ? {} : { idleMs }) }
  } catch (e) {
    const ms = performance.now() - t0
    return { members, operations, ms, msPerOp: ms / operations, error: (e as Error).message }
  } finally {
    // Auch nach einem Fehler: Adapter, Timer und Verbindungen schließen,
    // damit keine Hintergrundarbeit in den nächsten Lauf hineinwirkt.
    await candidate.dispose?.().catch(() => {})
  }
}

/**
 * Mehrere Läufe, gemeldet wird der Median. Browser runden
 * `performance.now()` teils auf ganze Millisekunden (Firefox, vermutlich
 * auch Vanadium); einzelne kurze Läufe sind dann nicht aussagekräftig.
 */
export async function runLoadMedian(make: () => Candidate, runs = 5, members = 30, operations = 500): Promise<LoadResult> {
  if (!Number.isInteger(runs) || runs <= 0) throw new RangeError(`runs muss eine positive ganze Zahl sein, war ${runs}`)
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

/**
 * S9b-Last: Inhalte statt Mitgliedschaft. Eine Gruppe mit `members` Personen,
 * `writes` verschlüsselte Einträge reihum, alle 50 wird zugestellt. Misst den
 * Durchsatz von Verschlüsseln, Verteilen und Entschlüsseln an alle Geräte.
 * `msPerDelivery`: Zeit je Gerät und empfangener Nachricht (was ein echtes
 * Gerät pro eingehender Nachricht zahlt; der Prüfstand rechnet alle Geräte in
 * einem Thread).
 */
export async function runContentLoad(make: () => Candidate, members = 10, writes = 100): Promise<LoadResult> {
  const candidate = make()
  const w = new World(candidate)
  const people = Array.from({ length: members }, (_, i) => `p${String(i).padStart(2, '0')}`)
  try {
    for (const p of people) await w.device(p, p)
    await w.flush()
    await w.createGroup('p00')
    for (const p of people.slice(1)) await w.add('p00', p)
    await w.flush()
    const t0 = performance.now()
    const idle0 = candidate.transport?.idleMs() ?? 0
    for (let i = 0; i < writes; i++) {
      await w.write(people[i % members]!, `eintrag-${i}`)
      if (i % 50 === 49) await w.flush()
    }
    await w.flush()
    const ms = performance.now() - t0
    const seen = w.read(people[members - 1]!).length
    const idle = candidate.transport ? candidate.transport.idleMs() - idle0 : undefined
    if (seen !== writes) {
      return { members, operations: writes, ms, msPerOp: ms / writes, error: `letztes Gerät liest ${seen} von ${writes}` }
    }
    // Bei eigenem Transport wird auch während des Wartens gearbeitet; eine
    // Zeit je Zustellung ließe sich nicht ehrlich angeben.
    if (idle !== undefined) return { members, operations: writes, ms, msPerOp: ms / writes, idleMs: idle }
    return { members, operations: writes, ms, msPerOp: ms / writes, msPerDelivery: ms / (writes * (members - 1)) }
  } catch (e) {
    return { members, operations: writes, ms: 0, msPerOp: 0, error: (e as Error).message }
  } finally {
    await candidate.dispose?.().catch(() => {})
  }
}
