// Every schedule, not a sample, of the rule in rule.ts: two people, two
// devices each. The two openings of a tuple are separate steps, each on a
// device of its person's choice; any device that holds a tuple may fetch
// what waits on it; own devices sync one way at a time, in any order.
// Every reachable state with all tuples open is brought to rest
// (everything synced, fetched and sent) and checked against what the two
// people's relations give.
import { DEVICES, contacts, rule, start, type Event, type Setup, type State } from './rule'

/** candidates are keyed by tuple; the key of a state must not depend on the order they were written in */
const keyOf = (s: State): string => JSON.stringify(s, (_k, v: unknown) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b))) : v)

export type Outcome = { states: number, atRest: Record<string, number>, problems: string[] }

function judge (setup: Setup, r: ReturnType<typeof rule>, s: State, atRest: Record<string, number>, problems: Set<string>): string {
  const rest = r.settle(s).state
  const want = JSON.stringify(r.expected(rest))
  const shown = DEVICES.map((d) => contacts(rest.devices[d].tuples, rest.devices[d].united))
  const label = `both relations give ${r.expected(rest).length}, devices show ${shown.map((g) => g.length).join('')}`
  atRest[label] = (atRest[label] ?? 0) + 1
  if (JSON.stringify(shown[0]) !== JSON.stringify(shown[1]) || JSON.stringify(shown[2]) !== JSON.stringify(shown[3])) problems.add('two devices of one person show different contacts at rest')
  if (shown.some((g) => JSON.stringify(g) !== want)) problems.add('a device shows other contacts than the pairs both relations hold')
  if (r.outstanding(rest, 'a').length || r.outstanding(rest, 'b').length) problems.add('a mapping stays owed at rest')
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
  return { states: seen.size, atRest, problems: [...problems].sort() }
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
  return { states: n, atRest, problems: [...problems].sort() }
}
