import { describe, expect, it } from 'vitest'
import { enumerateBranches, foldBranches, MAX_BRANCHES, type RunOutcome } from '../src/lab/zweige'
import { foldTiming } from '../src/lab/zeit'
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
  const t = { scenarios: ['S6'], runs: 3, cause: 'Zustellzeit', boundMs: 10_000, measure: () => undefined }
  const ok = { outcome: 'bestanden' as const, authority: 'Dave Mitglied: ja', keys: 'k' }
  it('bestanden nur, wenn jeder Lauf innerhalb der Schranke zustellt', () => {
    const r = foldTiming(t, [{ result: ok, ms: 2000 }, { result: ok, ms: 3000 }, { result: ok, ms: 2500 }])
    expect(r).toEqual({ outcome: 'bestanden', authority: 'Dave Mitglied: ja; 3/3 innerhalb 10.0 s (Zustellung min 2.0 / Median 2.5 / max 3.0 s)', keys: 'k' })
  })
  it('ein später oder ausgebliebener Lauf: nicht bestanden, „abhängig von“ mit k/N', () => {
    const fail = { outcome: 'nicht bestanden' as const, authority: 'Dave Mitglied: ja', keys: 'leer' }
    const r = foldTiming(t, [{ result: ok, ms: 2000 }, { result: ok, ms: 12_000 }, { result: fail, ms: undefined }])
    expect(r.outcome).toBe('nicht bestanden')
    expect(r.authority).toBe('abhängig von: Zustellzeit, 1/3 innerhalb 10.0 s (Zustellung min 2.0 / Median 2.0 / max 12.0 s; 1× ausgeblieben); Dave Mitglied: ja')
    expect(r.keys).toBe('[Lauf 2] k · [Lauf 3] leer')
  })
})
