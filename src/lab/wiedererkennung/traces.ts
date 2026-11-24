// Traces of the rule in rule.ts: for each case worth pinning, the shortest
// schedule the full walk finds, written out step by step until nothing is
// left to do, with what every device then shows. A trace is data
// (traces/*.json): another implementation of the rule replays the steps and
// compares. `build` recomputes them; the test fails when a file is stale.
import { DEVICES, relationships, rule, start, type Device, type Event, type Pair, type Person, type Setup, type State, type Tuple } from './rule'
import { walk } from './enumerate'

/** `after`: what the device the step acted on (for a sync, the one that received) shows then, and what each person still owes */
export type Step = Event & { effect: boolean, after: { relationships: Tuple[][], stillOwed: Record<Person, Pair[]> } }
export type Shown = { relationships: Record<Device, Tuple[][]>, candidates: Record<Person, Record<Tuple, Tuple[]>>, stillOwed: Record<Person, Pair[]> }
export type Trace = {
  name: string
  shows: string
  setup: Setup
  steps: Step[]
  expect: Shown
  /** the same steps under the control run (steps that cannot happen there are left out), where its outcome differs */
  readOnce?: { relationships: Record<Device, Tuple[][]> }
}

const shown = (setup: Setup, s: State): Shown => {
  const r = rule(setup)
  return {
    relationships: Object.fromEntries(DEVICES.map((d) => [d, relationships(s.devices[d].tuples, s.devices[d].united)])) as Shown['relationships'],
    candidates: { a: sorted(s.people.a.candidates), b: sorted(s.people.b.candidates) },
    stillOwed: { a: r.outstanding(s, 'a'), b: r.outstanding(s, 'b') },
  }
}
const sorted = <V>(o: Record<string, V>): Record<string, V> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))

/** Replay steps from the start. `lenient`: a step that cannot happen is left out (for the control run); otherwise it throws. */
export function replay (setup: Setup, steps: Event[], lenient = false): { state: State, steps: Step[] } {
  const r = rule(setup), done: Step[] = []
  let cur = start()
  for (const raw of steps) {
    const e = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'effect' && k !== 'after')) as Event
    if (lenient && !r.possible(cur, e)) continue
    const n = r.apply(cur, e), on = cur = n.state, dev = on.devices['sync' in e ? e.to : e.on]
    done.push({ ...e, effect: n.effect, after: { relationships: relationships(dev.tuples, dev.united), stillOwed: { a: r.outstanding(on, 'a'), b: r.outstanding(on, 'b') } } })
  }
  return { state: cur, steps: done }
}

/** The whole trace of a schedule: its steps, then everything that brings it to rest. */
function traceOf (name: string, shows: string, setup: Setup, schedule: Event[], withControl = false): Trace {
  const r = rule(setup), head = replay(setup, schedule), tail = r.settle(head.state)
  const steps = replay(setup, [...schedule, ...tail.events]).steps
  const t: Trace = { name, shows, setup, steps, expect: shown(setup, tail.state) }
  if (withControl) {
    const c = { ...setup, readOnce: true }, cr = rule(c)
    t.readOnce = { relationships: shown(c, cr.settle(replay(c, steps, true).state).state).relationships }
  }
  return t
}

export function build (): Trace[] {
  const setup: Setup = { tuples: ['t1', 't2'] }, r = rule(setup)
  const pick: Record<string, Event[]> = {}
  const idle = (s: State, ...ds: Device[]): boolean => ds.every((d) => s.devices[d].tuples.length === 0)
  const lists = (s: State, p: Person, t: Tuple, c: Tuple): boolean => (s.people[p].candidates[t] ?? []).includes(c)
  const take = (k: string, schedule: Event[]): void => { if (!(k in pick)) pick[k] = schedule }

  walk(setup, (schedule, s, label) => {
    const one = label === 'both relations give 1, devices show 1111', two = label === 'both relations give 2, devices show 2222'
    if (one && idle(s, 'a2', 'b2') && lists(s, 'a', 't2', 't1') && lists(s, 'b', 't2', 't1')) take('again', schedule)
    if (one && idle(s, 'a2', 'b2') && lists(s, 'a', 't2', 't1') && lists(s, 'b', 't1', 't2')) take('crossed', schedule)
    if (two && idle(s, 'b2') && s.people.a.candidates.t2?.length === 0 && lists(s, 'b', 't2', 't1') && s.devices.a1.tuples.join() === 't1' && s.devices.a2.tuples.join() === 't2') take('apart', schedule)
    if (one && !('readAgain' in pick)) {
      const c = { ...setup, readOnce: true }, end = rule(c).settle(replay(c, [...schedule, ...r.settle(s).events], true).state).state
      if (DEVICES.every((d) => relationships(end.devices[d].tuples, end.devices[d].united).length === 2)) take('readAgain', schedule)
    }
    if (one && !('cannotVerify' in pick)) {
      for (const e of r.events(s, false)) if ('fetchMapping' in e && !r.apply(s, e).effect) { take('cannotVerify', [...schedule, e]); break }
    }
  })

  return [
    traceOf('met-again', 'Two people who share a tuple meet again, one device each. Both proofs cross; one contact.', setup, pick.again as Event[]),
    traceOf('crossed-opening', 'The two people open the two tuples in opposite order (each scans the other at once). Neither probe lists the other tuple where the receiver looks first; the pair is admitted the other way round. One contact.', setup, pick.crossed as Event[]),
    traceOf('two-devices-apart', 'One person opens the second tuple on a device that has not heard of the first. Its relation does not hold the pair; it stays two relationships on both sides, also after everything is synced.', setup, pick.apart as Event[]),
    traceOf('probe-read-again', 'A device fetches a probe before it holds the other tuple; the tuple arrives later by sync. Reading the kept probe again gives the hit. Read once, the two people end with two relationships although both relations hold the pair.', setup, pick.readAgain as Event[], true),
    traceOf('mapping-not-verifiable', 'A mapping reaches a device that cannot verify it. Nothing changes and nothing is acknowledged; the sender keeps owing it until a device that can verify fetches it.', setup, pick.cannotVerify as Event[]),
    // three tuples, written by hand (the full walk covers two)
    traceOf('joined-by-a-third', 'Each person opened its first two tuples on two devices that had not synced, so neither admits that pair. Both then open a third tuple on a device that knows the two. Both admit each of them with the third; the chain of the two pairs makes one relationship of all three.', { tuples: ['t1', 't2', 't3'] }, [
      { open: 't1', on: 'a1' }, { open: 't1', on: 'b1' }, { open: 't2', on: 'a2' }, { open: 't2', on: 'b2' },
      { sync: 'a2', to: 'a1' }, { sync: 'b2', to: 'b1' }, { open: 't3', on: 'a1' }, { open: 't3', on: 'b1' },
    ]),
    ...([['t1', 't2', 't3'], ['t2', 't1', 't3']] as Tuple[][]).map((rank) => traceOf(
      `stale-device-${rank[0] === 't1' ? 'apart' : 'joined'}`,
      rank[0] === 't1'
        ? 'A device that knows the first tuple but not that its sibling united it with a second meets the same person again. It lists the first tuple; the other person lists the head of its relationship, the second. No pair is admitted by both: the third tuple stays a relationship of its own on every device, although each opening device knew the other person.'
        : 'The same schedule as stale-device-apart with the first tuple ranking above the second: the head of the other person\'s relationship is then the first tuple, both list it, and all three tuples end in one relationship. The rank decides.',
      { tuples: ['t1', 't2', 't3'], rank }, [
        { open: 't1', on: 'a1' }, { open: 't1', on: 'b1' }, { sync: 'a1', to: 'a2' }, { fetchProbe: 't1', on: 'a1' }, { fetchProbe: 't1', on: 'b1' },
        { open: 't2', on: 'a1' }, { open: 't2', on: 'b1' }, { fetchProbe: 't2', on: 'a1' }, { fetchProbe: 't2', on: 'b1' },
        { fetchMapping: 't1+t2', on: 'a1' }, { fetchMapping: 't1+t2', on: 'b1' },
        { open: 't3', on: 'a2' }, { open: 't3', on: 'b1' },
      ])),
    traceOf('settled-by-a-path', 'Three tuples, one device each, all open before anything is read. Person a owes three mappings. Once the pairs t1+t2 and t2+t3 are verified and acknowledged both ways, the mapping over t1+t3 is no longer owed: the other side holds the two tuples in one relationship already.', { tuples: ['t1', 't2', 't3'], single: true }, [
      { open: 't1', on: 'a1' }, { open: 't1', on: 'b1' }, { open: 't2', on: 'a1' }, { open: 't2', on: 'b1' }, { open: 't3', on: 'a1' }, { open: 't3', on: 'b1' },
      { fetchProbe: 't2', on: 'a1' }, { fetchProbe: 't3', on: 'a1' },
      { fetchMapping: 't1+t2', on: 'b1' }, { fetchMapping: 't2+t3', on: 'b1' }, { fetchMapping: 't1+t2', on: 'a1' }, { fetchMapping: 't2+t3', on: 'a1' },
    ]),
  ]
}
