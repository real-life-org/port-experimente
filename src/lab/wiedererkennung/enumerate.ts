// Every schedule, not a sample, of the rule in rule.ts: two people, two
// devices each. The two openings of a tuple are separate steps, each on a
// device of its person's choice; any device that holds a tuple may fetch
// what waits on it; own devices sync one way at a time, in any order.
// Every reachable state with all tuples open is brought to rest
// (everything synced, fetched and sent) and checked against what the two
// people's relations give.
import { DEVICES, relationships, rule, start, type Event, type Setup, type State } from './rule'

/** candidates are keyed by tuple; the key of a state must not depend on the order they were written in */
const keyOf = (s: State): string => JSON.stringify(s, (_k, v: unknown) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b))) : v)

/** `states`: reached; `judged`: of them, those with every tuple open on both sides, which are brought to rest and checked */
export type Outcome = { states: number, judged: number, atRest: Record<string, number>, problems: string[] }

function judge (setup: Setup, r: ReturnType<typeof rule>, s: State, atRest: Record<string, number>, problems: Set<string>): string {
  const rest = r.settle(s).state
  const want = JSON.stringify(r.expected(rest))
  const shown = DEVICES.map((d) => relationships(rest.devices[d].tuples, rest.devices[d].united))
  const label = `both relations give ${r.expected(rest).length}, devices show ${shown.map((g) => g.length).join('')}`
  atRest[label] = (atRest[label] ?? 0) + 1
  // with one device per person the second devices hold nothing and are not compared
  const acting = setup.single ? [0, 2] : [0, 1, 2, 3]
  if (!setup.single && (JSON.stringify(shown[0]) !== JSON.stringify(shown[1]) || JSON.stringify(shown[2]) !== JSON.stringify(shown[3]))) problems.add('two devices of one person show different relationships at rest')
  if (acting.some((i) => JSON.stringify(shown[i]) !== want)) problems.add('a device shows other relationships than the pairs both relations hold')
  if (r.outstanding(rest, 'a').length || r.outstanding(rest, 'b').length) problems.add('a mapping stays owed at rest')
  // a statement that does not read the candidates: one device per person, every tuple open on both sides, one relationship
  if (setup.single && acting.some((i) => (shown[i] as unknown[]).length !== 1)) problems.add('one device per person, and more than one relationship at rest')
  return label
}

/** Walk every reachable state. `found`, if given, is called with the schedule that first reached each state with all tuples open, and its label. */
export function walk (setup: Setup, found?: (schedule: Event[], state: State, label: string) => void): Outcome {
  const r = rule(setup), first = start()
  const seen = new Map<string, { from: string | null, by: Event | null }>([[keyOf(first), { from: null, by: null }]])
  const todo: State[] = [first], atRest: Record<string, number> = {}, problems = new Set<string>()
  const scheduleOf = (k: string): Event[] => { const out: Event[] = []; for (let c = seen.get(k); c?.by; c = seen.get(c.from as string)) out.unshift(c.by); return out }
  // breadth first, so that the schedule recorded for a state is a shortest one
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i] as State, k = keyOf(s)
    for (const e of r.events(s, true)) {
      const n = r.apply(s, e)
      if (!n.effect) continue
      const nk = keyOf(n.state)
      if (!seen.has(nk)) { seen.set(nk, { from: k, by: e }); todo.push(n.state) }
    }
    if (!r.allOpen(s)) continue
    const label = judge(setup, r, s, atRest, problems)
    if (found) found(scheduleOf(k), s, label)
  }
  return { states: seen.size, judged: Object.values(atRest).reduce((n, x) => n + x, 0), atRest, problems: [...problems].sort() }
}

/** Instead of every state: `n` random schedules (for three tuples, where the walk does not fit in memory). */
export function draw (setup: Setup, n: number): Outcome {
  const r = rule(setup), atRest: Record<string, number> = {}, problems = new Set<string>()
  for (let i = 0; i < n; i++) {
    let cur = start()
    for (let k = 0; k < 12 * setup.tuples.length || !r.allOpen(cur); k++) {
      const next = [...r.events(cur, true)].map((e) => r.apply(cur, e)).filter((x) => x.effect)
      if (!next.length) break
      cur = (next[Math.floor(Math.random() * next.length)] as { state: State }).state
    }
    judge(setup, r, cur, atRest, problems)
  }
  return { states: n, judged: n, atRest, problems: [...problems].sort() }
}
