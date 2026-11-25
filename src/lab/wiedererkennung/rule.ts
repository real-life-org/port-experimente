// Recognition of one person across several tuples, on several devices: the
// rule as a small model. Nothing here stores, sends or encrypts; a state is
// plain data and `apply` is the whole rule. It is written to be read by
// someone who implements the rule elsewhere, and it is what the traces
// under `traces/` were recorded from (traces.ts) and are checked against
// (tests/wiedererkennung-traces.test.ts).
//
// The words:
//
//   tuple       one pair of keys between two people, opened by one ceremony.
//               A person may hold several tuples with the same counterpart.
//   candidates  fixed when a device opens a tuple: the heads that device
//               held then. They are a fact of the person (its devices get
//               them by sync) and never change.
//   probe       sent on a tuple at its opening: it lists the opener's
//               candidates of that tuple, blinded. Whoever holds a listed
//               tuple can tell.
//   admitted    a pair of tuples is admitted for a person if one was a
//               candidate of the other, either way round.
//   proven      a pair of tuples is proven on a device if the device united
//               it (it verified the counterpart's mapping over it) and the
//               person's own mapping over it was acknowledged.
//   hit         a device reads a probe on a tuple it holds, the probe lists
//               another tuple the device holds, and either the pair is
//               admitted, or the listed tuple is the head of its relationship
//               on this device now and a proven pair joins it directly to a
//               candidate of the probe's tuple (the proven head). A tuple
//               that is no head never hits this second way.
//               A hit unites nothing; the person then owes its mapping.
//   mapping     the proof over a pair of tuples, under the keys of both. A
//               device that holds both tuples and either admits the pair or
//               already owes its own mapping over it verifies it, unites the
//               two, acknowledges, and its person owes its own mapping over
//               the pair. Any other device cannot verify it: no
//               acknowledgement, the sender keeps owing it.
//   relationship  the tuples a device holds, grouped by the pairs it united.
//               The head of a relationship is its tuple of the highest rank.
//               (Not the contact entry an app shows: a relationship can
//               stand behind more than one entry for a while. Entries are
//               not in this model.)
//   rank        the order of the tuples' record anchors. The record anchor
//               of a tuple is the smaller, by the bytes of the did:key
//               string, of its two pair anchors; it has nothing to do with
//               the order in which the tuples came about.
//   sync        a device hands its sibling what it knows: tuples, united
//               pairs, what the person owes, and the probes it fetched.
//
// The rule that is there for several devices: a probe a device fetched is
// kept, and the device reads the probes it holds again whenever what it
// holds grows or a pair becomes proven. It also hands them to its sibling.
// Control runs take this apart: `readOnce` (a probe is read when it is
// fetched and never again, and is not handed on), `noForward` (kept and
// read again by the device that fetched it, but not handed on) and
// `noProvenHead` (only admitted pairs hit).

export type Device = 'a1' | 'a2' | 'b1' | 'b2'
export type Person = 'a' | 'b'
export type Tuple = string
/** two tuples, the lower name first, joined by '+' */
export type Pair = string

export const DEVICES: readonly Device[] = ['a1', 'a2', 'b1', 'b2']
export const personOf = (d: Device): Person => d[0] as Person
export const otherPerson = (p: Person): Person => (p === 'a' ? 'b' : 'a')
export const siblingOf = (d: Device): Device => (d[0] + (d[1] === '1' ? '2' : '1')) as Device
export const pairOf = (x: Tuple, y: Tuple): Pair => (x < y ? `${x}+${y}` : `${y}+${x}`)
export const tuplesOf = (p: Pair): [Tuple, Tuple] => p.split('+') as [Tuple, Tuple]

export type DeviceState = {
  /** tuples this device holds */
  tuples: Tuple[]
  /** tuples on which it holds the counterpart's probe */
  probes: Tuple[]
  /** pairs it united */
  united: Pair[]
  /** pairs over which its person owes a mapping, as far as this device knows */
  owed: Pair[]
  /** per owed pair: the tuple its mapping travels on, the one on which the probe or mapping that caused it arrived */
  via: Record<Pair, Tuple>
}
export type PersonState = {
  /** tuples the person opened, on whichever device */
  opened: Tuple[]
  /** per opened tuple: the heads its opening device held then */
  candidates: Record<Tuple, Tuple[]>
  /** tuples on which the counterpart's probe waits at the carrier */
  waiting: Tuple[]
  /** pairs whose own mapping the counterpart verified and acknowledged */
  acknowledged: Pair[]
}
export type State = { devices: Record<Device, DeviceState>, people: Record<Person, PersonState> }

export type Event =
  | { open: Tuple, on: Device }
  | { fetchProbe: Tuple, on: Device }
  | { fetchMapping: Pair, on: Device }
  | { sync: Device, to: Device }

export type Setup = {
  /** the tuples, in the order they come about */
  tuples: Tuple[]
  /** the tuples by rank, lowest first (the order of their record anchors); the default is the order they come about */
  rank?: Tuple[]
  /** control run: a probe is read by the device that fetched it, when it fetches it, and never again; it is not handed on */
  readOnce?: boolean
  /** control run: a probe stays with the device that fetched it, which reads it again when what it holds grows */
  noForward?: boolean
  /** one device per person: only a1 and b1 act, nothing is synced */
  single?: boolean
  /** control run: only admitted pairs hit and are verified; a listed tuple that is the head a proven pair joins to a candidate does not */
  noProvenHead?: boolean
}

const add = <T>(xs: T[], x: T): T[] => (xs.includes(x) ? xs : [...xs, x].sort())
const union = <T>(xs: T[], ys: T[]): T[] => [...new Set([...xs, ...ys])].sort()
const sameSet = <T>(xs: T[], ys: T[]): boolean => xs.length === ys.length && xs.every((x) => ys.includes(x))
const within = <T>(xs: T[], ys: T[]): boolean => xs.every((x) => ys.includes(x))

export const start = (): State => ({
  devices: Object.fromEntries(DEVICES.map((d) => [d, { tuples: [], probes: [], united: [], owed: [], via: {} }])) as unknown as State['devices'],
  people: { a: { opened: [], candidates: {}, waiting: [], acknowledged: [] }, b: { opened: [], candidates: {}, waiting: [], acknowledged: [] } },
})
const copy = (s: State): State => JSON.parse(JSON.stringify(s)) as State

/** The relationships of a device: its tuples, grouped by the pairs it united (only pairs whose two tuples it holds count). */
export function relationships (tuples: Tuple[], united: Pair[]): Tuple[][] {
  const group = new Map<Tuple, Tuple>(tuples.map((t) => [t, t]))
  const find = (t: Tuple): Tuple => { const g = group.get(t) as Tuple; return g === t ? t : find(g) }
  for (const p of united) { const [x, y] = tuplesOf(p); if (tuples.includes(x) && tuples.includes(y)) group.set(find(x), find(y)) }
  const out = new Map<Tuple, Tuple[]>()
  for (const t of [...tuples].sort()) out.set(find(t), [...(out.get(find(t)) ?? []), t])
  return [...out.values()].sort((g, h) => (g[0] as Tuple).localeCompare(h[0] as Tuple))
}

export function rule (setup: Setup) {
  if (setup.tuples.some((t) => t.includes('+') || t === '') || new Set(setup.tuples).size !== setup.tuples.length) throw new Error('tuple names must be distinct, not empty and without "+"')
  const rank = setup.rank ?? setup.tuples
  if (rank.length !== setup.tuples.length || !setup.tuples.every((t) => rank.includes(t))) throw new Error('rank must order exactly the tuples')
  const forward = !setup.readOnce && !setup.noForward
  const higher = (x: Tuple, y: Tuple): Tuple => (rank.indexOf(x) > rank.indexOf(y) ? x : y)
  /** the head of every relationship of a device */
  const heads = (d: DeviceState): Tuple[] => relationships(d.tuples, d.united).map((g) => g.reduce(higher)).sort()

  const admitted = (s: State, p: Person, x: Tuple, y: Tuple): boolean =>
    (s.people[p].candidates[x] ?? []).includes(y) || (s.people[p].candidates[y] ?? []).includes(x)
  /** `named`, read in a probe on `t`, is this device's head now and a proven pair joins it directly to a candidate of `t`.
   *  The key of a tuple that is no head any more opens nothing this way. */
  const provenHead = (s: State, d: Device, t: Tuple, named: Tuple): boolean => {
    if (setup.noProvenHead) return false
    const dev = s.devices[d], ack = s.people[personOf(d)].acknowledged
    return heads(dev).includes(named) && (s.people[personOf(d)].candidates[t] ?? []).some((c) => dev.united.includes(pairOf(c, named)) && ack.includes(pairOf(c, named)))
  }

  /** The person owes its mapping over `p`; it travels on `on` unless the device already knows another tuple for it (one intent per pair). */
  const owe = (dev: DeviceState, p: Pair, on: Tuple): void => { dev.owed = add(dev.owed, p); if (!(p in dev.via)) dev.via[p] = on }

  /** A device reads probes it holds (all of them, or the one on `only`): every hit makes its person owe the mapping. */
  const read = (s: State, d: Device, only?: Tuple): void => {
    const me = personOf(d), dev = s.devices[d]
    for (const t of dev.probes) {
      if (only !== undefined && t !== only) continue
      for (const named of s.people[otherPerson(me)].candidates[t] ?? []) {
        if (named !== t && dev.tuples.includes(named) && (admitted(s, me, t, named) || provenHead(s, d, t, named))) owe(dev, pairOf(t, named), t)
      }
    }
  }

  const both = (p: Person): [Device, Device] => [`${p}1` as Device, `${p}2` as Device]
  /** Pairs over which the person still owes a mapping: owed, not acknowledged, and not already settled by a path. A pair is
   *  settled by a path when its two tuples are joined by pairs each of which the person verified (united) and had its own
   *  mapping acknowledged for: the counterpart then holds the two tuples in one relationship already. */
  const outstanding = (s: State, p: Person): Pair[] => {
    const [d1, d2] = both(p), ack = s.people[p].acknowledged
    const proven = union(s.devices[d1].united, s.devices[d2].united).filter((x) => ack.includes(x))
    const joined = relationships(setup.tuples, proven)
    return union(s.devices[d1].owed, s.devices[d2].owed).filter((x) => !ack.includes(x) && !joined.some((g) => tuplesOf(x).every((t) => g.includes(t))))
  }
  /** the tuple a person's mapping over `x` travels on */
  const travelsOn = (s: State, p: Person, x: Pair): Tuple => { const [d1, d2] = both(p); return [s.devices[d1].via[x], s.devices[d2].via[x]].filter((t): t is Tuple => t !== undefined).sort()[0] as Tuple }

  /** Whether the event can happen in `s`. A mapping can be fetched by any device that holds the tuple it travels on; whether it then has an effect is `apply`'s. */
  function possible (s: State, e: Event): boolean {
    if (setup.single && ('sync' in e || e.on === 'a2' || e.on === 'b2')) return false
    if ('open' in e) {
      const me = personOf(e.on), i = setup.tuples.indexOf(e.open)
      if (i < 0 || s.people[me].opened.includes(e.open)) return false
      // a tuple comes about only after the one before it: someone has opened that one
      return i === 0 || s.people.a.opened.includes(setup.tuples[i - 1] as Tuple) || s.people.b.opened.includes(setup.tuples[i - 1] as Tuple)
    }
    if ('fetchProbe' in e) return s.people[personOf(e.on)].waiting.includes(e.fetchProbe) && s.devices[e.on].tuples.includes(e.fetchProbe)
    if ('fetchMapping' in e) {
      const sender = otherPerson(personOf(e.on))
      return outstanding(s, sender).includes(e.fetchMapping) && s.devices[e.on].tuples.includes(travelsOn(s, sender, e.fetchMapping))
    }
    if (e.to !== siblingOf(e.sync)) return false
    const from = s.devices[e.sync], to = s.devices[e.to]
    return !within(from.tuples, to.tuples) || !within(from.united, to.united) || !within(from.owed, to.owed) || (forward && !within(from.probes, to.probes))
  }

  /** The state after the event, and whether the event changed anything. */
  function apply (s: State, e: Event): { state: State, effect: boolean } {
    if (!possible(s, e)) throw new Error(`not possible here: ${JSON.stringify(e)}`)
    const n = copy(s)
    if ('open' in e) {
      const me = personOf(e.on), dev = n.devices[e.on]
      n.people[me].candidates[e.open] = heads(dev)
      n.people[me].opened = add(n.people[me].opened, e.open)
      dev.tuples = add(dev.tuples, e.open)
      n.people[otherPerson(me)].waiting = add(n.people[otherPerson(me)].waiting, e.open)   // its probe leaves for the counterpart
      if (!setup.readOnce) read(n, e.on)
      return { state: n, effect: true }
    }
    if ('fetchProbe' in e) {
      const me = personOf(e.on), dev = n.devices[e.on]
      n.people[me].waiting = n.people[me].waiting.filter((t) => t !== e.fetchProbe)
      dev.probes = add(dev.probes, e.fetchProbe)
      read(n, e.on, setup.readOnce ? e.fetchProbe : undefined)
      return { state: n, effect: true }
    }
    if ('fetchMapping' in e) {
      const me = personOf(e.on), dev = n.devices[e.on], [x, y] = tuplesOf(e.fetchMapping)
      // cannot verify: it does not hold both tuples, or its person does not admit the pair. No acknowledgement, nothing changes.
      // a pair it already owes: the hit decided, and stands also if the head changed since
      const owedHere = !setup.noProvenHead && dev.owed.includes(e.fetchMapping)
      if (!dev.tuples.includes(x) || !dev.tuples.includes(y) || !(admitted(s, me, x, y) || owedHere)) return { state: s, effect: false }
      dev.united = add(dev.united, e.fetchMapping)
      owe(dev, e.fetchMapping, travelsOn(s, otherPerson(me), e.fetchMapping))   // the answer travels on the tuple the mapping came on
      n.people[otherPerson(me)].acknowledged = add(n.people[otherPerson(me)].acknowledged, e.fetchMapping)
      // a pair became proven or a head changed: a kept probe may hit now. On this device, which verified, and on the
      // counterpart's, whose acknowledgement just arrived (the model keeps it per person, so both its devices read again).
      if (!setup.noProvenHead && !setup.readOnce) for (const d of [e.on, ...both(otherPerson(me))]) read(n, d)
      return { state: n, effect: true }
    }
    const from = n.devices[e.sync], to = n.devices[e.to]
    to.tuples = union(to.tuples, from.tuples); to.united = union(to.united, from.united); to.owed = union(to.owed, from.owed)
    to.via = { ...from.via, ...to.via }
    if (forward) to.probes = union(to.probes, from.probes)
    if (!setup.readOnce) read(n, e.to)
    return { state: n, effect: true }
  }

  /** Every event possible in `s`. `openings`: the ceremonies too; without them, what is left to do once every tuple is open. */
  function * events (s: State, openings: boolean): Generator<Event> {
    for (const d of DEVICES) {
      const me = personOf(d)
      if (openings) for (const t of setup.tuples) if (possible(s, { open: t, on: d })) yield { open: t, on: d }
      for (const t of setup.tuples) if (possible(s, { fetchProbe: t, on: d })) yield { fetchProbe: t, on: d }
      for (const p of outstanding(s, otherPerson(me))) if (possible(s, { fetchMapping: p, on: d })) yield { fetchMapping: p, on: d }
      if (possible(s, { sync: d, to: siblingOf(d) })) yield { sync: d, to: siblingOf(d) }
    }
  }

  /** The events that bring `s` to rest: everything synced, fetched and sent, in a fixed order. */
  function settle (s: State): { state: State, events: Event[] } {
    const done: Event[] = []
    let cur = s
    for (;;) {
      let moved = false
      for (const e of events(cur, false)) {
        const r = apply(cur, e)
        if (!r.effect) continue
        cur = r.state; done.push(e); moved = true; break
      }
      if (!moved) return { state: cur, events: done }
    }
  }

  /** What the two candidate relations give: the tuples grouped by the pairs both people admit. At rest every device shows
   *  at least these joins. A proven head adds joins that depend on the order things happened in; they are no function of
   *  the candidates, so the walk checks them as agreement of the two people and the traces pin the cases. */
  const expected = (s: State): Tuple[][] => {
    const joint: Pair[] = []
    for (const x of setup.tuples) for (const y of setup.tuples) if (x < y && admitted(s, 'a', x, y) && admitted(s, 'b', x, y)) joint.push(pairOf(x, y))
    return relationships(setup.tuples, joint)
  }
  const allOpen = (s: State): boolean => sameSet(s.people.a.opened, setup.tuples) && sameSet(s.people.b.opened, setup.tuples)

  return { possible, apply, events, settle, expected, outstanding, travelsOn, allOpen, heads, admitted }
}
