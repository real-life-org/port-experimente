import type { Candidate, CandidateFactory, TimingSpec } from './types'
import type { RunOutcome } from './zweige'

// Prüfstandsregel (Anton 18.10.2026), Fall Zeit: hängt ein Szenario von Zustellzeiten ab (`Candidate.timing`),
// zählt kein Einzellauf. Das Szenario läuft `runs`-mal auf je einem frischen Kandidaten; je Lauf misst der Kandidat,
// wie lange die Zustellung dauerte. Bestanden nur, wenn jeder Lauf besteht und innerhalb der Schranke zustellt,
// die der Kandidat aus seinen eigenen Parametern herleitet. Sonst „abhängig von: <Ursache>, k/N“.

export interface TimedRun {
  readonly result: RunOutcome
  /** Längste Zustellzeit des Laufs in ms; `undefined`: eine Zustellung blieb aus. */
  readonly ms: number | undefined
}

/** Läuft das Szenario `t.runs`-mal; `first` ist schon gebaut (Fähigkeitsprüfung), jeder weitere Lauf baut neu. */
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
    } finally {
      await c.dispose?.()
    }
  }
  return runs
}

const s = (ms: number) => (ms / 1000).toFixed(1)

/** Die Verteilung als Text: „k/N innerhalb B s (Zustellung min/Median/max …; n× ausgeblieben)“. */
export function distribution(t: TimingSpec, runs: readonly TimedRun[]): { kept: number; text: string } {
  const kept = runs.filter((r) => r.result.outcome === 'bestanden' && r.ms !== undefined && r.ms <= t.boundMs).length
  const times = runs.flatMap((r) => (r.ms === undefined ? [] : [r.ms])).sort((a, b) => a - b)
  const missing = runs.length - times.length
  const spread = times.length ? `Zustellung min ${s(times[0]!)} / Median ${s(times[Math.floor((times.length - 1) / 2)]!)} / max ${s(times.at(-1)!)} s` : 'keine Zustellung'
  return { kept, text: `${kept}/${runs.length} innerhalb ${s(t.boundMs)} s (${spread}${missing ? `; ${missing}× ausgeblieben` : ''})` }
}

export function foldTiming(t: TimingSpec, runs: readonly TimedRun[]): RunOutcome {
  if (runs.every((r) => r.result.outcome === 'nicht abbildbar')) return runs[0]!.result
  const { kept, text } = distribution(t, runs)
  const uniform = (pick: (r: RunOutcome) => string, rs: readonly TimedRun[]) => {
    const texts = [...new Set(rs.map((r) => pick(r.result)))]
    return texts.length === 1 ? texts[0]! : rs.map((r) => `[Lauf ${runs.indexOf(r) + 1}] ${pick(r.result)}`).join(' · ')
  }
  if (kept === runs.length) return { outcome: 'bestanden', authority: `${uniform((r) => r.authority, runs)}; ${text}`, keys: uniform((r) => r.keys, runs) }
  const bad = runs.filter((r) => !(r.result.outcome === 'bestanden' && r.ms !== undefined && r.ms <= t.boundMs))
  return { outcome: 'nicht bestanden', authority: `abhängig von: ${t.cause}, ${text}; ${uniform((r) => r.authority, runs)}`, keys: uniform((r) => r.keys, bad) }
}
