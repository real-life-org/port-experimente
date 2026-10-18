import { describe, expect, it } from 'vitest'
import { enumerateBranches, foldBranches, MAX_BRANCHES, type RunOutcome } from '../src/lab/zweige'
import { foldTiming, measureRuns, runFaults } from '../src/lab/zeit'
import type { Candidate, CoinBranches } from '../src/lab/types'

// Prüfstandsregel (Anton 18.10.): eine Zelle gilt nur, wenn sie in jedem Zweig hält. Ein gespielter Münzwurf:
// `decisionsPerRun` sagt, wie viele Entscheidungen ein Lauf trifft (abhängig von den erzwungenen), `verdict`, ob er besteht.
function coin(decisionsPerRun: (forced: readonly number[]) => number, complete = true) {
  let forced: readonly number[] = []
  let released = 0
  const b: CoinBranches = {
    coin: 'Gleichstand',
    sides: ['früherer gewinnt', 'späterer gewinnt'],
    force: (d) => void (forced = d),
    trace: () => ({ decisions: decisionsPerRun(forced), complete }),
    release: () => void released++,
  }
  const candidate = (): Candidate => ({ id: 'münze', capabilities: new Set(), branches: b }) as unknown as Candidate
  return { b, candidate, forced: () => forced, released: () => released }
}

async function run(c: ReturnType<typeof coin>, verdict: (forced: readonly number[]) => boolean) {
  const seen: number[][] = []
  const once = async (): Promise<RunOutcome> => {
    seen.push([...c.forced()])
    return { outcome: verdict(c.forced()) ? 'bestanden' : 'nicht bestanden', authority: `a${c.forced().join('')}`, keys: 'k' }
  }
  const { runs, exhausted } = await enumerateBranches(c.candidate(), async () => c.candidate(), once)
  return { runs, exhausted, seen, folded: foldBranches(c.b, runs, exhausted) }
}

describe('Zweige eines Münzwurfs', () => {
  it('ohne Entscheidung: ein Lauf, Ergebnis unverändert', async () => {
    const c = coin(() => 0)
    const r = await run(c, () => true)
    expect(r.runs).toHaveLength(1)
    expect(r.folded).toEqual({ outcome: 'bestanden', authority: 'a', keys: 'k' })
    expect(c.released()).toBe(1)
  })

  it('eine Entscheidung: beide Seiten laufen; besteht nur eine, ist das Szenario nicht bestanden und nennt den Zweig', async () => {
    const r = await run(coin(() => 1), (f) => (f[0] ?? 0) === 0)
    expect(r.runs.map((x) => x.decisions)).toEqual([[0], [1]])
    expect(r.folded.outcome).toBe('nicht bestanden')
    expect(r.folded.authority).toBe('abhängig von: Gleichstand, Zweig späterer gewinnt verletzt (1/2): a1; bestanden in früherer gewinnt')
  })

  it('besteht in jedem Zweig: bestanden', async () => {
    const r = await run(coin(() => 1), () => true)
    expect(r.folded.outcome).toBe('bestanden')
    expect(r.folded.authority).toBe('in jedem Zweig (2 Zweige, Gleichstand): [früherer gewinnt] a · [späterer gewinnt] a1') // der erste Lauf erzwingt nichts (Seite 0)
  })

  it('besteht in keinem Zweig: nicht bestanden, ohne „abhängig von“', async () => {
    const r = await run(coin(() => 1), () => false)
    expect(r.folded.outcome).toBe('nicht bestanden')
    expect(r.folded.authority).toMatch(/^in keinem Zweig bestanden \(2 Zweige, Gleichstand\)/)
  })

  it('Entscheidungen, die erst ein Zweig öffnet, werden mit aufgezählt (Baum, kein Würfelwurf)', async () => {
    // Seite 1 der ersten Entscheidung führt zu einer zweiten.
    const r = await run(coin((f) => ((f[0] ?? 0) === 1 ? 2 : 1)), (f) => (f[1] ?? 0) === 0)
    expect(r.runs.map((x) => x.decisions).sort()).toEqual([[0], [1, 0], [1, 1]])
    expect(r.folded.authority).toMatch(/^abhängig von: Gleichstand, Zweig späterer gewinnt → späterer gewinnt verletzt \(1\/3\)/)
  })

  it('unvollständige Aufzählung belegt kein Bestehen', async () => {
    const r = await run(coin(() => 1, false), () => true)
    expect(r.folded.outcome).toBe('nicht bestanden')
    expect(r.folded.authority).toContain('Zweige nicht vollständig aufgezählt')
    const many = await run(coin(() => 8), () => true)
    expect(many.runs).toHaveLength(MAX_BRANCHES)
    expect(many.exhausted).toBe(true)
    expect(many.folded.outcome).toBe('nicht bestanden')
  })
})

describe('Zeit als Verteilung', () => {
  // Ohne Zustellschranke im Stack steht die Zelle fest rot (Anton 18.10., Review 23 B1/B2); gemessen wird eine
  // Verteilung innerhalb eines Beobachtungsfensters, die nur in den Details steht.
  const t = { scenarios: ['S6'], runs: 3, cause: 'Zustellzeit', noBound: 'keine Zustellschranke im Stack', windowMs: 10_000, measure: () => undefined }
  const ok = { outcome: 'bestanden' as const, authority: 'Dave Mitglied: ja', keys: 'k' }
  const fail = { outcome: 'nicht bestanden' as const, authority: 'Dave Mitglied: ja', keys: 'leer' }
  it('jeder Lauf schnell zugestellt: trotzdem nicht bestanden, die Verteilung steht in den Details', () => {
    const r = foldTiming(t, [{ result: ok, ms: 2000 }, { result: ok, ms: 3000 }, { result: ok, ms: 2500 }])
    expect(r.outcome).toBe('nicht bestanden')
    expect(r.authority).toBe(
      'abhängig von: Zustellzeit; keine Zustellschranke im Stack; Verteilung: 3/3 innerhalb des Beobachtungsfensters 10.0 s (Zustellung min 2.0 / Median 2.5 / max 3.0 s); Dave Mitglied: ja',
    )
    expect(r.keys).toBe('k')
  })
  it('ein später oder ausgebliebener Lauf: derselbe Ausgang, nur die Verteilung ändert sich', () => {
    const r = foldTiming(t, [{ result: ok, ms: 2000 }, { result: ok, ms: 12_000 }, { result: fail, ms: undefined }])
    expect(r.outcome).toBe('nicht bestanden')
    expect(r.authority).toBe(
      'abhängig von: Zustellzeit; keine Zustellschranke im Stack; Verteilung: 1/3 innerhalb des Beobachtungsfensters 10.0 s (Zustellung min 2.0 / Median 2.0 / max 12.0 s; 1× ausgeblieben); Dave Mitglied: ja',
    )
    expect(r.keys).toBe('[Lauf 2] k · [Lauf 3] leer')
  })
  it('der Ausgang hängt nicht von den Zeiten ab', () => {
    const fast = foldTiming(t, [{ result: ok, ms: 100 }, { result: ok, ms: 100 }, { result: ok, ms: 100 }])
    const slow = foldTiming(t, [{ result: fail, ms: undefined }, { result: fail, ms: undefined }, { result: fail, ms: undefined }])
    expect(fast.outcome).toBe(slow.outcome)
  })
  it('jeder Lauf steht strukturiert im Ergebnis', () => {
    const r = foldTiming(t, [{ result: ok, ms: 2000 }, { result: fail, ms: undefined, error: 'boom' }])
    expect(r.runs).toEqual([
      { outcome: 'bestanden', authority: 'Dave Mitglied: ja', keys: 'k', ms: 2000 },
      { outcome: 'nicht bestanden', authority: 'Dave Mitglied: ja', keys: 'leer', ms: undefined, error: 'boom' },
    ])
  })
  it('streng je Lauf: eine Ausnahme oder eine fehlende Aussage in einem Lauf ist ein Befund (Review 23 B3)', () => {
    const good = { outcome: 'bestanden' as const, authority: 'Dave Mitglied: ja; x', keys: 'k', ms: 2000 }
    const runs = [good, good, good, good, { outcome: 'nicht bestanden' as const, authority: 'Fehler: boom', keys: '—', ms: undefined, error: 'boom' }]
    expect(runFaults(runs, 'Dave Mitglied: ja')).toEqual(['Lauf 5: Ausnahme: boom', 'Lauf 5: ohne „Dave Mitglied: ja“'])
    expect(runFaults([good, { ...good, authority: 'Dave Mitglied: nein' }], 'Dave Mitglied: ja')).toEqual(['Lauf 2: ohne „Dave Mitglied: ja“'])
    expect(runFaults([good, good], 'Dave Mitglied: ja')).toEqual([])
  })
})

describe('measureRuns', () => {
  it('eine Ausnahme in einem Lauf wird festgehalten, nicht verschluckt; jeder Lauf baut frisch und räumt auf', async () => {
    let built = 0
    let disposed = 0
    const mk = (): Candidate => {
      built++
      return { id: 'z', capabilities: new Set(), dispose: async () => void disposed++, timing: { scenarios: ['S6'], runs: 3, cause: 'c', noBound: 'n', windowMs: 1000, measure: () => 500 } } as unknown as Candidate
    }
    let i = 0
    const runs = await measureRuns(mk(), async () => mk(), async () => {
      if (++i === 2) throw new Error('boom')
      return { outcome: 'bestanden', authority: 'Dave Mitglied: ja', keys: 'k' }
    })
    expect(built).toBe(3)
    expect(disposed).toBe(3)
    expect(runs.map((r) => r.error)).toEqual([undefined, 'boom', undefined])
    expect(runs[1]!.result).toEqual({ outcome: 'nicht bestanden', authority: 'Fehler: boom', keys: '—' })
  })
})
