import type { Candidate, CandidateFactory, RunReport, TimingSpec } from './types'
import type { RunOutcome } from './zweige'

// Prüfstandsregel (Anton 18.10.2026), Fall Zeit: hängt ein Szenario von Zustellzeiten ab (`Candidate.timing`) und gibt
// der Stack keine Zustellschranke zu, hält die Zelle nicht in jedem Zweig: eine langsame Zustellung ist immer möglich.
// Die Zelle steht deshalb fest „nicht bestanden, abhängig von …“, unabhängig von den gemessenen Zeiten (Review 23 B1/B2).
// Gemessen wird trotzdem: das Szenario läuft `runs`-mal auf je einem frischen Kandidaten, je Lauf misst der Kandidat die
// Zustellzeit; die Verteilung (k/N innerhalb des Beobachtungsfensters, min/Median/max) steht in den Details. Das
// Beobachtungsfenster ist keine Schranke, nur die Wartezeit des Prüfstands je Lauf.

export interface TimedRun {
  readonly result: RunOutcome
  /** Längste Zustellzeit des Laufs in ms; `undefined`: eine Zustellung blieb aus. */
  readonly ms: number | undefined
  /** Der Lauf brach mit einer Ausnahme ab (Meldung); `result` ist dann „nicht bestanden, Fehler: …“. */
  readonly error?: string
}

/**
 * Läuft das Szenario `t.runs`-mal; `first` ist schon gebaut (Fähigkeitsprüfung), jeder weitere Lauf baut neu. Eine
 * Ausnahme bricht nur ihren Lauf ab und wird als `error` festgehalten, nie verschluckt (Review 23 B3).
 */
export async function measureRuns(first: Candidate, make: CandidateFactory, once: (c: Candidate) => Promise<RunOutcome>): Promise<TimedRun[]> {
  const t = first.timing!
  const runs: TimedRun[] = []
  let candidate: Candidate | undefined = first
  for (let i = 0; i < t.runs; i++) {
    const c: Candidate = candidate ?? (await make())
    candidate = undefined
    try {
      const result = await once(c)
      runs.push({ result, ms: c.timing!.measure() })
    } catch (e) {
      const error = (e as Error).message
      runs.push({ result: { outcome: 'nicht bestanden', authority: `Fehler: ${error}`, keys: '—' }, ms: undefined, error })
    } finally {
      await c.dispose?.()
    }
  }
  return runs
}

const s = (ms: number) => (ms / 1000).toFixed(1)
const delivered = (t: TimingSpec, r: TimedRun) => r.result.outcome === 'bestanden' && r.ms !== undefined && r.ms <= t.windowMs

/** Die Verteilung als Text: „k/N innerhalb des Beobachtungsfensters W s (Zustellung min/Median/max …; n× ausgeblieben)“. */
export function distribution(t: TimingSpec, runs: readonly TimedRun[]): { kept: number; text: string } {
  const kept = runs.filter((r) => delivered(t, r)).length
  const times = runs.flatMap((r) => (r.ms === undefined ? [] : [r.ms])).sort((a, b) => a - b)
  const missing = runs.length - times.length
  const spread = times.length ? `Zustellung min ${s(times[0]!)} / Median ${s(times[Math.floor((times.length - 1) / 2)]!)} / max ${s(times.at(-1)!)} s` : 'keine Zustellung'
  return { kept, text: `${kept}/${runs.length} innerhalb des Beobachtungsfensters ${s(t.windowMs)} s (${spread}${missing ? `; ${missing}× ausgeblieben` : ''})` }
}

/** Fest „nicht bestanden“ (ohne Zustellschranke hält die Zelle nicht in jedem Zweig); die Verteilung steht in den Details. */
export function foldTiming(t: TimingSpec, runs: readonly TimedRun[]): RunOutcome & { runs: RunReport[] } {
  const reports: RunReport[] = runs.map((r) => ({ ...r.result, ms: r.ms, ...(r.error === undefined ? {} : { error: r.error }) }))
  if (runs.every((r) => r.result.outcome === 'nicht abbildbar')) return { ...runs[0]!.result, runs: reports }
  const { text } = distribution(t, runs)
  const uniform = (pick: (r: RunOutcome) => string, rs: readonly TimedRun[]) => {
    const texts = [...new Set(rs.map((r) => pick(r.result)))]
    return texts.length === 1 ? texts[0]! : rs.map((r) => `[Lauf ${runs.indexOf(r) + 1}] ${pick(r.result)}`).join(' · ')
  }
  const bad = runs.filter((r) => !delivered(t, r))
  return {
    outcome: 'nicht bestanden',
    authority: `abhängig von: ${t.cause}; ${t.noBound}; Verteilung: ${text}; ${uniform((r) => r.authority, runs)}`,
    keys: uniform((r) => r.keys, bad.length ? bad : runs),
    runs: reports,
  }
}

/**
 * Strenge Prüfung je Lauf (Review 23 B3): jede Ausnahme und jeder Lauf ohne die geforderte Aussage ist ein Befund.
 * Leer heißt: jeder Lauf ohne Ausnahme, jeder Lauf mit `must` in den Details.
 */
export function runFaults(runs: readonly RunReport[], must: string): string[] {
  return runs.flatMap((r, i) => [
    ...(r.error !== undefined ? [`Lauf ${i + 1}: Ausnahme: ${r.error}`] : []),
    ...(r.authority.includes(must) ? [] : [`Lauf ${i + 1}: ohne „${must}“`]),
  ])
}
