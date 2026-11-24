// Every schedule, not a sample: the recognition of Trust 6a (0.32
// inventory) on two devices per person, with the probe kept in the log and
// read again when the log brings a tuple into its candidate relation.
//
// Two people, two devices each, two or three tuples. The two openings of
// an encounter are separate steps, each on a device of its person's
// choice; any device that holds a tuple may fetch what waits on it; own
// devices sync one way at a time, in any order (for three tuples: both
// ways at once, to keep the walk finite in memory). Every reachable state is
// then run to rest (everything synced, fetched and sent) and checked.
//
// What is modelled of the inventory: the candidates of a tuple are the
// heads its opening device held (2300); the probe on a tuple lists them
// (6730, 6750); a receiver has a hit for a listed tuple it holds if the
// pair is in its own relation, either way round (6800, 6802); a hit makes
// it owe its mapping for the pair (6845.1); a mapping is verified against
// the receiver's own relation (6960), unites, is acknowledged at that
// effect and makes the receiver owe its own (6975, DEL-CONT-1); a mapping
// a device cannot verify is not acknowledged and stays owed (6845.4).
// Added for several devices: the probe a device fetched is a fact its
// siblings get, and every device reads the probes it holds again whenever
// its facts grow.

export type P = 0 | 1
type Dev = { has: number, probe: number, edges: number, owed: number }
type State = {
  dev: Dev[]                 // 0,1: person 0; 2,3: person 1
  opened: number[]           // per person: bitset of tuples opened
  heads: number[][]          // per person, per tuple: bitset of candidates fixed at the opening
  inbox: number[]            // per person: bitset of tuples with an unfetched probe of the other
  acked: number[]            // per person: bitset of pairs whose own mapping the other side booked
}
const personOf = (d: number): P => (d < 2 ? 0 : 1)
const bit = (i: number): number => 1 << i

/** `sample`: instead of walking every state, draw that many random schedules (for three tuples, where the walk does not fit in memory). */
export function explore (tuples: number, rereadProbes: boolean, syncBothWays = false, sample = 0): { states: number, atRest: Record<string, number>, problems: string[] } {
  const pairs: Array<[number, number]> = []
  for (let x = 0; x < tuples; x++) for (let y = x + 1; y < tuples; y++) pairs.push([x, y])
  const pairBit = (x: number, y: number): number => bit(pairs.findIndex(([p, q]) => p === Math.min(x, y) && q === Math.max(x, y)))

  /** Groups of the tuples `has` under the pairs `edges`; the head of a group is its largest tuple. */
  const groups = (has: number, edges: number): number[] => {
    const g: number[] = []
    for (let t = 0; t < tuples; t++) g[t] = t
    const find = (t: number): number => (g[t] === t ? t : (g[t] = find(g[t] as number)))
    pairs.forEach(([x, y], i) => { if (edges & bit(i) && has & bit(x) && has & bit(y)) g[find(x)] = find(y) })
    return [...Array(tuples).keys()].map(find)
  }
  const headsOf = (has: number, edges: number): number => {
    const g = groups(has, edges); let out = 0
    for (let t = 0; t < tuples; t++) if (has & bit(t)) { let h = t; for (let u = 0; u < tuples; u++) if (has & bit(u) && g[u] === g[t] && u > h) h = u; out |= bit(h) }
    return out
  }
  /** The pair is in the person's relation: one was a candidate of the other. */
  const cand = (s: State, p: P, t: number): number => (s.heads[p] as number[])[t] as number
  const admitted = (s: State, p: P, x: number, y: number): boolean => Boolean(cand(s, p, x) & bit(y) || cand(s, p, y) & bit(x))

  /** A device reads probes it holds (all of them, or only the one on `only`): a listed tuple it holds, in its relation with the probe's tuple, is a hit, and its person owes the mapping. */
  const read = (s: State, d: number, only = -1): void => {
    const me = personOf(d), other = (1 - me) as P, v = s.dev[d] as Dev
    for (let t = 0; t < tuples; t++) {
      if (!(v.probe & bit(t)) || (only >= 0 && t !== only)) continue
      const listed = cand(s, other, t)
      for (let c = 0; c < tuples; c++) if (c !== t && listed & bit(c) && v.has & bit(c) && admitted(s, me, t, c)) v.owed |= pairBit(t, c)
    }
  }
  const clone = (s: State): State => ({ dev: s.dev.map((d) => ({ ...d })), opened: [...s.opened], heads: s.heads.map((h) => [...h]), inbox: [...s.inbox], acked: [...s.acked] })
  const key = (s: State): string => JSON.stringify(s)

  /** Every step possible in `s`. `free`: also the steps a schedule may choose (openings); at rest only syncs, fetches and sendings are left. */
  function * steps (s: State, free: boolean): Generator<State> {
    for (let d = 0; d < 4; d++) {
      const me = personOf(d), other = (1 - me) as P, v = s.dev[d] as Dev
      // open a tuple: tuples come about in order, and a tuple is opened by one device per person
      if (free) for (let t = 0; t < tuples; t++) {
        if ((s.opened[me] as number) & bit(t)) continue
        if (t > 0 && !((s.opened[0] as number) & bit(t - 1) || (s.opened[1] as number) & bit(t - 1))) continue
        const n = clone(s), nv = n.dev[d] as Dev
        ;(n.heads[me] as number[])[t] = headsOf(v.has, v.edges)
        n.opened[me] = (n.opened[me] as number) | bit(t); nv.has |= bit(t); n.inbox[other] = (n.inbox[other] as number) | bit(t)
        if (rereadProbes) read(n, d)                                        // read once: an opening reads nothing again
        yield n
      }
      // fetch the other side's probe on a tuple this device holds
      for (let t = 0; t < tuples; t++) if ((s.inbox[me] as number) & bit(t) && v.has & bit(t)) {
        const n = clone(s), nv = n.dev[d] as Dev
        n.inbox[me] = (n.inbox[me] as number) & ~bit(t); nv.probe |= bit(t)
        read(n, d, rereadProbes ? -1 : t); yield n                          // read once: only the probe just fetched
      }
      // fetch a mapping the other side owes and has not had acknowledged; it travels on the larger tuple of its pair
      const owedByOther = ((s.dev[other * 2] as Dev).owed | (s.dev[other * 2 + 1] as Dev).owed) & ~(s.acked[other] as number)
      for (let i = 0; i < pairs.length; i++) {
        const [x, y] = pairs[i] as [number, number]
        if (!(owedByOther & bit(i)) || !(v.has & bit(y))) continue
        if (!(v.has & bit(x)) || !admitted(s, me, x, y)) continue            // cannot verify: no acknowledgement, nothing changes
        const n = clone(s), nv = n.dev[d] as Dev
        nv.edges |= bit(i); nv.owed |= bit(i); n.acked[other] = (n.acked[other] as number) | bit(i)
        yield n
      }
      // sync to the sibling
      const sib = d ^ 1, w = s.dev[sib] as Dev
      if (syncBothWays && (d & 1)) continue
      const differs = syncBothWays ? (w.has !== v.has || (rereadProbes && w.probe !== v.probe) || w.edges !== v.edges || w.owed !== v.owed) : ((w.has | v.has) !== w.has || (rereadProbes && (w.probe | v.probe) !== w.probe) || (w.edges | v.edges) !== w.edges || (w.owed | v.owed) !== w.owed)
      if (differs) {
        const n = clone(s), nw = n.dev[sib] as Dev
        nw.has |= v.has; nw.edges |= v.edges; nw.owed |= v.owed
        if (rereadProbes) { nw.probe |= v.probe; read(n, sib) }
        if (syncBothWays) { const nv = n.dev[d] as Dev; nv.has = nw.has; nv.edges = nw.edges; nv.owed = nw.owed; if (rereadProbes) { nv.probe = nw.probe; read(n, d) } }
        yield n
      }
    }
  }
  const rest = (s: State): State => { let cur = s; for (;;) { const nx = steps(cur, false).next(); if (nx.done) return cur; cur = nx.value } }

  const start: State = { dev: [0, 1, 2, 3].map(() => ({ has: 0, probe: 0, edges: 0, owed: 0 })), opened: [0, 0], heads: [Array(tuples).fill(0), Array(tuples).fill(0)], inbox: [0, 0], acked: [0, 0] }
  const seen = new Set<string>([key(start)]), todo = [start], atRest: Record<string, number> = {}, problems = new Set<string>()
  const drawn: State[] = []
  for (let i = 0; i < sample; i++) {
    let cur = start
    for (let k = 0; k < 12 * tuples; k++) { const next = [...steps(cur, true)]; if (!next.length) break; cur = next[Math.floor(Math.random() * next.length)] as State }
    while ((cur.opened[0] as number) !== bit(tuples) - 1 || (cur.opened[1] as number) !== bit(tuples) - 1) { const next = [...steps(cur, true)]; cur = next[Math.floor(Math.random() * next.length)] as State }
    drawn.push(cur)
  }
  if (sample) todo.length = 0
  const check = sample ? drawn : todo
  while (check.length) {
    const s = check.pop() as State
    if (!sample) for (const n of steps(s, true)) { const k = key(n); if (!seen.has(k)) { seen.add(k); todo.push(n) } }
    if ((s.opened[0] as number) !== bit(tuples) - 1 || (s.opened[1] as number) !== bit(tuples) - 1) continue
    // all tuples opened on both sides: run to rest and check
    const r = rest(s)
    // expected: the components of the pairs both relations hold
    let both = 0
    pairs.forEach(([x, y], i) => { if (admitted(r, 0, x, y) && admitted(r, 1, x, y)) both |= bit(i) })
    const want = groups(bit(tuples) - 1, both).join('')
    const shown = r.dev.map((d) => groups(d.has, d.edges).join(''))
    const contacts = (g: string): number => new Set(g).size
    const label = `both relations give ${contacts(want)}, devices show ${shown.map(contacts).join('')}`
    atRest[label] = (atRest[label] ?? 0) + 1
    if (shown[0] !== shown[1] || shown[2] !== shown[3]) problems.add('two devices of one person show different contacts at rest')
    if (shown.some((g) => g !== want)) problems.add('a device shows other contacts than the pairs both relations hold')
    for (const p of [0, 1] as const) if (((r.dev[p * 2] as Dev).owed | (r.dev[p * 2 + 1] as Dev).owed) & ~(r.acked[p] as number)) problems.add('a mapping stays owed at rest')
    if (contacts(want) > 1) {
      // could one more step of knowledge have joined them? count for the record
      atRest['at rest with more than one contact'] = (atRest['at rest with more than one contact'] ?? 0) + 1
    }
  }
  return { states: sample || seen.size, atRest, problems: [...problems].sort() }
}
