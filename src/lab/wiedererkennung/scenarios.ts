// Scenarios for the model of model.ts: the cases the probe of Trust 6a
// needed rules of their own for with several devices, and the counter-runs
// of three design reviews of 24 November. A measurement of the model, not
// of the library.
import { randomInt } from 'node:crypto'
import { Carrier, STEP, contacts, device, forge, headOf, image, meet, readable, receive, relationships, send, share, type Device, type End } from './model'

export type Row = Record<string, string | number | boolean>
const settle = (c: Carrier, devs: Device[]): void => { for (const d of devs) receive(d, c) }
/** The person's devices sync with each other. */
const sync = (devs: Device[]): void => { for (const x of devs) for (const y of devs) if (x !== y) share(x, y) }
/** Every device fetches what waits; then every device sends what its person owes and all fetch, `n` times. Returns the documents sent. */
const run = (c: Carrier, devs: Device[], n = 3): number => { let docs = 0; settle(c, devs); for (let i = 0; i < n; i++) { for (const d of devs) docs += send(d, c); settle(c, devs) } return docs }
/** `dev` gets `n` contacts, each with one device, all settled. */
function knows (dev: Device, n: number, c: Carrier): Device[] {
  const out: Device[] = []
  for (let i = 0; i < n; i++) { const o = device(`other-${i}`); meet(dev, o, c); settle(c, [dev, o]); out.push(o) }
  return out
}
const endOf = (dev: Device, id: string): End => [...dev.ends.values()].find((e) => e.id === id) as End
const together = (dev: Device, ...ids: string[]): boolean => relationships(dev).some((g) => ids.every((id) => g.includes(id)))

/** Two people who never met; both have other contacts. */
function strangers (): Row {
  const c = new Carrier(), [a, x] = [device('a'), device('x')] as [Device, Device]
  knows(a, 5, c); knows(x, 3, c)
  const before = c.log.length
  const t = meet(a, x, c); const later = run(c, [a, x])
  const docs = c.log.slice(before)
  return {
    'contacts of a afterwards': contacts(a),
    'contacts of the stranger afterwards': contacts(x),
    'values the stranger got from a (a holds 5 other contacts)': docs.filter((d) => d.from === 'a').reduce((n, d) => n + d.tags.length, 0),
    'of them the stranger can read': docs.filter((d) => d.from === 'a').reduce((n, d) => n + readable(x, d), 0),
    'documents on other tuples than the fresh one': docs.filter((d) => d.on !== t).length,
    'documents after the two probes': later,
  }
}

/** Two people with a relationship meet again, one device each. */
function again (): Row {
  const c = new Carrier(), [a, b] = [device('a'), device('b')] as [Device, Device]
  knows(a, 4, c)
  meet(a, b, c); run(c, [a, b])
  const before = c.log.length
  meet(a, b, c); settle(c, [a, b])
  const afterProbes = [contacts(a) - 4, contacts(b)]
  run(c, [a, b])
  return {
    'after the two probes arrived, a holds of b': afterProbes[0] as number,
    'and b holds of a': afterProbes[1] as number,
    'documents in all (two probes, then each side\'s own proof for the pair)': c.log.length - before,
    'pairs either side still owes a proof for': [...a.owed].filter((p) => !a.done.has(p)).length + [...b.owed].filter((p) => !b.done.has(p)).length,
    'acts of the users': 0,
  }
}

/** A has a phone and a laptop; the laptop meets B again. `synced`: whether the laptop knows the relationship the phone made. */
function ownDevices (synced: boolean): Row {
  const c = new Carrier(), phone = device('phone'), laptop = device('laptop', phone), b = device('b')
  meet(phone, b, c); run(c, [phone, b])
  if (synced) sync([phone, laptop])
  meet(laptop, b, c); run(c, [laptop, b])
  const first = { laptop: contacts(laptop), b: contacts(b) }
  sync([phone, laptop])
  const docs = run(c, [phone, laptop, b]); sync([phone, laptop])
  return {
    'right after the encounter the laptop holds of b': first.laptop,
    'and b holds of a': first.b,
    'documents after a\'s devices synced': docs,
    'then the phone holds of b': contacts(phone),
    'the laptop': contacts(laptop),
    'and b of a': contacts(b),
    'another meeting was needed': false,
  }
}

/** Both have two devices; A's phone meets B's phone while A's laptop meets B's laptop, all four apart. */
function crossed (): Row {
  const c = new Carrier(), a1 = device('a1'), a2 = device('a2', a1), b1 = device('b1'), b2 = device('b2', b1)
  meet(a1, b1, c); meet(a2, b2, c); run(c, [a1, a2, b1, b2])
  sync([a1, a2]); run(c, [a1, a2, b1, b2]); sync([a1, a2])
  const half = [contacts(a1), Math.max(contacts(b1), contacts(b2))]
  sync([b1, b2]); run(c, [a1, a2, b1, b2]); sync([a1, a2]); sync([b1, b2])
  return {
    'after a\'s devices synced and sent, a holds of b': half[0] as number,
    'b\'s devices, not synced yet, each hold of a': half[1] as number,
    'after b\'s devices synced too, a holds of b': [contacts(a1), contacts(a2)].join(' and '),
    'and b of a': [contacts(b1), contacts(b2)].join(' and '),
    'another meeting was needed': false,
  }
}

/** A's phone and laptop, apart, each meet a different person. */
function twoStrangersApart (): Row {
  const c = new Carrier(), phone = device('phone'), laptop = device('laptop', phone), x = device('x'), y = device('y')
  meet(phone, x, c); meet(laptop, y, c); run(c, [phone, laptop, x, y])
  sync([phone, laptop])
  const before = c.log.length
  run(c, [phone, laptop, x, y], 5)
  const late = c.log.slice(before)
  return {
    'contacts of a afterwards': [contacts(phone), contacts(laptop)].join(' and '),
    'one of the two strangers gets, per sending of a, documents': late.length / 10,
    'values in each': late[0]?.tags.length ?? 0,
    'of them the stranger can read': late.reduce((n, d) => n + readable(x, d) + readable(y, d), 0),
    'the stranger acknowledges it': late.some((d) => c.acked.has(d.id)),
  }
}

/** A re-encounter where one side's own proof is lost on the way; the device that sent it is gone, its sibling sends it again. */
function lost (): Row {
  const c = new Carrier(), a1 = device('a1'), a2 = device('a2', a1), b = device('b')
  meet(a1, b, c); run(c, [a1, b]); sync([a1, a2])
  meet(a1, b, c); settle(c, [a1, b])
  c.drop = 1; send(a1, c); settle(c, [b])                  // a1's own proof for the pair is lost
  share(a1, a2)                                            // a2 learns what a owes; a1 is gone
  const again = send(a2, c); settle(c, [b]); send(a2, c)
  return {
    'documents the sibling sends for it': again,
    'pairs a still owes afterwards': [...a2.owed].filter((p) => !a2.done.has(p)).length,
    'a holds of b': contacts(a2),
    'b holds of a': contacts(b),
  }
}

/** A device fetches the other side's documents, unites, and is lost before it shares it. */
function fetchedAndLost (): Row {
  const c = new Carrier(), a1 = device('a1'), a2 = device('a2', a1), b = device('b')
  meet(a1, b, c); run(c, [a1, b]); sync([a1, a2])
  meet(a2, b, c); share(a2, a1)
  run(c, [a1, b])                                          // a1 does all the receiving and sending for a; then a1 is gone
  const stuck = [contacts(a2), contacts(b)]
  run(c, [a2, b])
  const still = contacts(a2)
  meet(a2, b, c); run(c, [a2, b])
  return {
    'a\'s remaining device holds of b': stuck[0] as number,
    'and b holds of a': stuck[1] as number,
    'after both sent all they owe, a holds of b': still,
    'after the next encounter a holds of b': contacts(a2),
  }
}

/** A device of B fetches A's proof for a pair of which it holds one tuple only. */
function unreadable (): Row {
  const c = new Carrier(), a1 = device('a1'), a2 = device('a2', a1), b1 = device('b1'), b2 = device('b2', b1)
  const t1 = meet(a1, b1, c); run(c, [a1, b1]); share(b1, b2)   // b2 knows the first tuple
  const t2 = meet(a2, b1, c)                               // a2 has not heard of it; b1 opens the second knowing the first
  settle(c, [a2]); sync([a1, a2])                          // b1's probe reached a2 before a2 held the first tuple
  send(a1, c); settle(c, [t1 > t2 ? b2 : b1])              // a's own proof goes on the tuple of the larger name; b2 holds only the first
  const before = contacts(a1)
  sync([b1, b2]); run(c, [a1, a2, b1, b2]); sync([a1, a2]); sync([b1, b2])
  return {
    'before b\'s devices synced, a holds of b': before,
    'afterwards a holds of b': [contacts(a1), contacts(a2)].join(' and '),
    'and b of a': [contacts(b1), contacts(b2)].join(' and '),
  }
}

/** B, who shares a tuple with A, hands in a value on a tuple of A with someone else. */
function onAForeignTuple (): Row {
  const c = new Carrier(), [a, b, y] = [device('a'), device('b'), device('y')] as [Device, Device, Device]
  const x = meet(a, b, c), t = meet(a, y, c); settle(c, [a, b, y])
  forge(c, 'probe', endOf(b, x), { id: t, from: endOf(y, t).side }); forge(c, 'map', endOf(b, x), { id: t, from: endOf(y, t).side }); receive(a, c)
  return { 'a counts the other person as b': together(a, x, t), 'contacts of a': contacts(a) }
}

/** A's phone and laptop know B and C; then the two devices scan each other. */
function ownDevicesScan (): Row {
  const c = new Carrier(), phone = device('phone'), laptop = device('laptop', phone), b = device('b'), d = device('c')
  meet(phone, b, c); meet(phone, d, c); run(c, [phone, b, d]); sync([phone, laptop])
  meet(phone, laptop, c); run(c, [phone, laptop]); sync([phone, laptop]); run(c, [phone, laptop, b, d])
  return { 'contacts of other people afterwards': relationships(phone).filter((g) => g.length === 1).length - 1, 'b and c fell into one': contacts(phone) < 3 }
}

/** Someone copied one end of a tuple of B's relationship with A and meets A
 *  as a new contact. `which`: the head of the relationship, or a tuple
 *  behind it. `way`: the value stands on the fresh tuple or on the old one. */
function copied (which: 'the head' | 'an older tuple', way: 'on the fresh tuple' | 'on the old tuple'): Row {
  const c = new Carrier(), [a, b, thief] = [device('a'), device('b'), device('thief')] as [Device, Device, Device]
  const t1 = meet(a, b, c); run(c, [a, b]); const t2 = meet(a, b, c); run(c, [a, b])
  const h = headOf(a, t1), old = h === t1 ? t2 : t1
  const stolen = { ...endOf(b, which === 'the head' ? h : old) }
  const t = meet(a, thief, c), mine = endOf(thief, t)
  for (const kind of ['probe', 'map'] as const) {
    if (way === 'on the fresh tuple') forge(c, kind, stolen, { id: t, from: mine.side, key: mine.key })
    else forge(c, kind, mine, { id: stolen.id, from: stolen.side, key: stolen.key })
  }
  run(c, [a, thief])
  return { 'a counts the newcomer as b': together(a, t1, t), 'contacts of a': contacts(a) }
}

/** The third review's case: a tuple is no head on A's phone any more; A's
 *  laptop never heard of it and meets someone who holds a copy of B's end
 *  of it. Then A's devices sync. */
function copiedAndApart (): Row {
  for (let i = 0; i < 200; i++) {
    const c = new Carrier(), phone = device('phone'), laptop = device('laptop', phone), b = device('b'), thief = device('thief')
    const x = meet(phone, b, c); run(c, [phone, b]); const h = meet(phone, b, c); run(c, [phone, b])
    if (headOf(phone, x) === x) continue
    const stolen = { ...endOf(b, x) }
    const y = meet(laptop, thief, c), mine = endOf(thief, y)
    sync([phone, laptop])
    for (const kind of ['probe', 'map'] as const) { forge(c, kind, stolen, { id: y, from: mine.side, key: mine.key }); forge(c, kind, mine, { id: x, from: stolen.side, key: stolen.key }) }
    run(c, [phone, laptop, thief]); sync([phone, laptop])
    return { 'a counts the newcomer as b': together(phone, x, y) || together(phone, h, y), 'contacts of a': contacts(phone) }
  }
  return { 'the case did not come up in 200 draws': true }
}

/** Three tuples of A and B. B's second device made the third knowing the first but not the second. */
function threeTuples (): Row {
  const c = new Carrier(), a = device('a'), b1 = device('b1'), b2 = device('b2', b1)
  meet(a, b1, c); run(c, [a, b1]); share(b1, b2)
  meet(a, b1, c); meet(a, b2, c); settle(c, [a])
  const before = contacts(a)
  run(c, [a, b1, b2]); sync([b1, b2]); run(c, [a, b1, b2]); sync([b1, b2])
  return {
    'after the probes, before b\'s devices synced, a holds of b': before,
    'at the end a holds of b': contacts(a),
    'and b of a': [contacts(b1), contacts(b2)].join(' and '),
  }
}

/** B lost everything and meets A with a new device. */
function dataLoss (): Row {
  const c = new Carrier(), [a, b, bNew] = [device('a'), device('b'), device('b-new')] as [Device, Device, Device]
  meet(a, b, c); run(c, [a, b])
  meet(a, bNew, c); run(c, [a, bNew])
  return { 'a holds of b': contacts(a), 'b holds of a': contacts(bNew) }
}

/** A, with one device, is restored from an image taken before its second
 *  tuple with B, and then meets B again. `head`: which of the two tuples B
 *  holds as the head, the one A still has or the one A lost. */
function restored (head: 'kept' | 'lost'): Row {
  for (let i = 0; i < 200; i++) {
    const c = new Carrier(), a = device('a'), b = device('b')
    const t1 = meet(a, b, c); run(c, [a, b])
    const old = image(a)
    meet(a, b, c); run(c, [a, b])
    if ((headOf(b, t1) === t1) !== (head === 'kept')) continue
    meet(old, b, c); run(c, [old, b])
    const first = [contacts(old), contacts(b)]
    meet(old, b, c); run(c, [old, b])
    return { 'after the restore and one encounter, a holds of b': first[0] as number, 'and b of a': first[1] as number, 'after one more encounter b holds of a': contacts(b) }
  }
  return { 'the case did not come up in 200 draws': true }
}

/** Three people with 3, 3 and 2 devices; encounters, deliveries, syncs of single pairs of devices and sendings in random order, nothing lost; then everything sent, delivered and synced. */
function randomSchedules (runs: number): Row {
  let wrong = 0, false_ = 0, open = 0
  for (let r = 0; r < runs; r++) {
    const c = new Carrier()
    const a = [device('a1')]; a.push(device('a2', a[0]), device('a3', a[0]))
    const b = [device('b1')]; b.push(device('b2', b[0]), device('b3', b[0]))
    const x = [device('x1')]; x.push(device('x2', x[0]))
    const people = [a, b, x], all = [...a, ...b, ...x]
    const pick = <T>(xs: T[]): T => xs[randomInt(xs.length)] as T
    for (let i = 0; i < 16; i++) {
      const k = randomInt(4)
      if (k === 0) { const p = pick(people), q = pick(people.filter((o) => o !== p)); meet(pick(p), pick(q), c) } else if (k === 1) receive(pick(all), c)
      else if (k === 2) { const p = pick(people), d1 = pick(p), d2 = pick(p.filter((o) => o !== d1)); share(d1, d2) } else send(pick(all), c)
    }
    for (let i = 0; i < 4; i++) { for (const p of people) sync(p); run(c, all, 1) }
    for (const p of people) sync(p)
    const owner = new Map<string, Set<Device[]>>()
    for (const p of people) for (const d of p) for (const e of d.ends.values()) owner.set(e.id, (owner.get(e.id) ?? new Set()).add(p))
    for (const p of people) for (const d of p) {
      const partners = new Set<Device[]>()
      for (const g of relationships(d)) {
        const others = new Set(g.flatMap((id) => [...(owner.get(id) as Set<Device[]>)].filter((o) => o !== p)))
        if (others.size > 1) false_++
        for (const o of others) partners.add(o)
      }
      if (contacts(d) !== partners.size) wrong++
      // a proof still owed between two tuples of the same two people
      for (const pr of d.owed) if (!d.done.has(pr)) { const [s, t] = pr.split('|') as [string, string]; if ([...(owner.get(s) as Set<Device[]>)].every((o) => (owner.get(t) as Set<Device[]>).has(o))) open++ }
    }
  }
  return { runs, 'devices that show more or fewer contacts than people they know': wrong, 'contacts that hold tuples of two people': false_, 'proofs still owed between two tuples of the same two people': open }
}

/** What one encounter costs someone with many contacts. */
function cost (n: number): Row {
  const c = new Carrier(), [a, x] = [device('a'), device('x')] as [Device, Device]
  knows(a, n, c)
  const before = c.log.length
  const t = meet(a, x, c); run(c, [a, x])
  const docs = c.log.slice(before)
  return { 'values a sends on the fresh tuple': docs.filter((d) => d.on === t && d.from === 'a').reduce((s, d) => s + d.tags.length, 0), 'documents on other tuples': docs.filter((d) => d.on !== t).length, 'step of the filling': STEP }
}

export const measure = (): Record<string, Row> => ({
  'two strangers meet': strangers(),
  'two who know each other meet again': again(),
  'a\'s laptop, which knows the relationship, meets b again': ownDevices(true),
  'a\'s laptop, which has not heard of the relationship yet, meets b again': ownDevices(false),
  'both have two devices and meet crosswise, all four apart': crossed(),
  'a\'s two devices, apart, each meet someone else': twoStrangersApart(),
  'a proof is lost on the way': lost(),
  'a device fetches, unites and is lost before it shares it': fetchedAndLost(),
  'a device fetches a proof it cannot read': unreadable(),
  'a contact hands in a value on a tuple that is not its own': onAForeignTuple(),
  'a\'s own devices scan each other': ownDevicesScan(),
  'a copied key of the head of a relationship': copied('the head', 'on the fresh tuple'),
  'a copied key of an older tuple, the value on the fresh tuple': copied('an older tuple', 'on the fresh tuple'),
  'a copied key of an older tuple, the value on the old tuple': copied('an older tuple', 'on the old tuple'),
  'a copied key of a tuple that is no head any more, met by a device that never heard of it': copiedAndApart(),
  'three tuples, the third made by a device that knew only the first': threeTuples(),
  'b lost everything': dataLoss(),
  'a is restored from an image older than its second tuple with b; b\'s head is the tuple a kept': restored('kept'),
  'the same; b\'s head is the tuple a lost': restored('lost'),
  'random schedules': randomSchedules(60),
  'cost with 300 contacts': cost(300),
})
