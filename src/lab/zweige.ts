import type { Candidate, CandidateFactory, CoinBranches, Outcome } from './types'

// Prüfstandsregel (Anton 18.10.2026): eine Zelle gilt nur, wenn sie in jedem Zweig hält. Entscheidet ein Kandidat
// nach Zufall (`Candidate.branches`), läuft jedes Szenario in jedem Zweig: der Prüfstand erzwingt je Entscheidung
// jede Seite und zählt die Zweige als Baum auf (Tiefensuche über die Entscheidungen, in der Reihenfolge, in der der
// Kandidat sie trifft). Das Szenario besteht nur, wenn es in jedem Zweig besteht; sonst steht in der Ausgabe, von
// welchem Zufall es abhängt und welcher Zweig verletzt. Keine Marke „nicht deterministisch“, kein gelockertes Orakel.

/** Mehr Läufe je Szenario werden nicht aufgezählt; darüber gilt die Aufzählung als unvollständig. */
export const MAX_BRANCHES = 16

export type RunOutcome = { outcome: Outcome; authority: string; keys: string }

export interface BranchRun {
  /** Erzwungene Seite je Entscheidung, so viele, wie im Lauf fielen. */
  readonly decisions: readonly number[]
  readonly result: RunOutcome
  readonly complete: boolean
}

/** Name eines Zweigs, z. B. „früherer gewinnt“ oder „früherer, dann späterer gewinnt“. */
export function branchName(b: CoinBranches, decisions: readonly number[]): string {
  if (!decisions.length) return `ohne ${b.coin}`
  return decisions.map((d) => b.sides[d === 1 ? 1 : 0]).join(' → ')
}

/**
 * Alle Zweige eines Szenarios. `once` läuft auf einem frischen Kandidaten (der erste ist schon gebaut, für die
 * Fähigkeitsprüfung); `force` steht vor jedem Lauf, `release` nach dem letzten.
 */
export async function enumerateBranches(
  first: Candidate,
  make: CandidateFactory,
  once: (c: Candidate) => Promise<RunOutcome>,
): Promise<{ runs: BranchRun[]; exhausted: boolean }> {
  const b = first.branches!
  const runs: BranchRun[] = []
  const todo: number[][] = [[]]
  let candidate: Candidate | undefined = first
  try {
    while (todo.length) {
      if (runs.length >= MAX_BRANCHES) return { runs, exhausted: true }
      const prefix = todo.pop()!
      const c: Candidate = candidate ?? (await make())
      candidate = undefined
      let result: RunOutcome
      let trace: { decisions: number; complete: boolean }
      try {
        await b.force(prefix)
        result = await once(c)
      } finally {
        trace = b.trace()
        await c.dispose?.()
      }
      const decisions = Array.from({ length: Math.max(trace.decisions, prefix.length) }, (_, i) => prefix[i] ?? 0)
      runs.push({ decisions, result, complete: trace.complete })
      // Jede Entscheidung, die dieser Lauf ohne Vorgabe auf Seite 0 getroffen hat, öffnet einen Zweig mit Seite 1.
      for (let i = decisions.length - 1; i >= prefix.length; i--) todo.push([...decisions.slice(0, i), 1])
    }
    return { runs, exhausted: false }
  } finally {
    b.release()
  }
}

/**
 * Faltet die Zweige zu einem Ergebnis: bestanden nur, wenn jeder Zweig besteht und die Aufzählung vollständig ist.
 * Verletzt ein Teil der Zweige: nicht bestanden, „abhängig von: <Zufall>, Zweig <x> verletzt …“.
 */
export function foldBranches(b: CoinBranches, runs: readonly BranchRun[], exhausted: boolean): RunOutcome {
  const name = (r: BranchRun) => branchName(b, r.decisions)
  const pass = runs.filter((r) => r.result.outcome === 'bestanden')
  const fail = runs.filter((r) => r.result.outcome === 'nicht bestanden')
  const incomplete = exhausted || runs.some((r) => !r.complete)
  const n = runs.length
  // Kein Zufall gefallen: ein Zweig, das Ergebnis unverändert.
  if (n === 1 && !incomplete) return runs[0]!.result
  const tag = `${n} ${n === 1 ? 'Zweig' : 'Zweige'}`
  const uniform = (pick: (r: RunOutcome) => string, rs: readonly BranchRun[]) => {
    const texts = [...new Set(rs.map((r) => pick(r.result)))]
    return texts.length === 1 ? texts[0]! : rs.map((r) => `[${name(r)}] ${pick(r.result)}`).join(' · ')
  }
  if (runs.every((r) => r.result.outcome === 'nicht abbildbar')) return { outcome: 'nicht abbildbar', authority: uniform((r) => r.authority, runs), keys: uniform((r) => r.keys, runs) }
  const gap = incomplete ? `; Zweige nicht vollständig aufgezählt (${exhausted ? `mehr als ${MAX_BRANCHES}` : `ein Commit in mehreren Gleichständen`}): ein Bestehen ist nicht belegt` : ''
  if (fail.length && pass.length) {
    return {
      outcome: 'nicht bestanden',
      authority: `abhängig von: ${b.coin}, Zweig ${fail.map(name).join(', ')} verletzt (${fail.length}/${n}): ${uniform((r) => r.authority, fail)}; bestanden in ${pass.map(name).join(', ')}${gap}`,
      keys: uniform((r) => r.keys, fail),
    }
  }
  if (fail.length || pass.length < runs.length) {
    const bad = fail.length ? fail : runs.filter((r) => r.result.outcome !== 'bestanden')
    return { outcome: 'nicht bestanden', authority: `in keinem Zweig bestanden (${tag}, ${b.coin}): ${uniform((r) => r.authority, bad)}${gap}`, keys: uniform((r) => r.keys, bad) }
  }
  if (incomplete) return { outcome: 'nicht bestanden', authority: `${uniform((r) => r.authority, runs)}${gap}`, keys: uniform((r) => r.keys, runs) }
  return { outcome: 'bestanden', authority: `in jedem Zweig (${tag}, ${b.coin}): ${uniform((r) => r.authority, runs)}`, keys: uniform((r) => r.keys, runs) }
}
