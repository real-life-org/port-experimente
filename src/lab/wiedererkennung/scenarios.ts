// Scenarios for the model of model.ts: the cases the probe of Trust 6a
// needed rules of their own for, and the counter-runs of the design review
// of 24 November, each as plain facts. A measurement of the model, not of
// the library.
import { randomInt } from 'node:crypto'
import { Carrier, STEP, catchUp, contacts, device, forge, headOf, meet, readable, receive, relationships, sendAgain, share, type Device, type End } from './model'

export type Row = Record<string, string | number | boolean>
const settle = (c: Carrier, devs: Device[]): void => { for (const d of devs) receive(d, c) }
/** The person's devices sync with each other, and each then sends what its person owes. */
const sync = (c: Carrier, devs: Device[]): number => {
  for (const x of devs) for (const y of devs) if (x !== y) share(x, y)
  let docs = 0
  for (const d of devs) { docs += catchUp(d, c); for (const y of devs) if (y !== d) share(d, y) }
  return docs
}
/** `dev` gets `n` contacts, each with one device, all settled. */
function knows (dev: Device, n: number, c: Carrier): Device[] {
  const out: Device[] = []
  for (let i = 0; i < n; i++) { const o = device(`other-${i}`); meet(dev, o, c); settle(c, [dev, o]); out.push(o) }
  return out
}
const endOf = (dev: Device, id: string): End => [...dev.ends.values()].find((e) => e.id === id) as End
const valuesOn = (dev: Device, t: string): number => [...dev.got.values()].filter((d) => d.on === t).reduce((n, d) => n + d.tags.length, 0)

/** Two people who never met; both have other contacts. */
function strangers (): Row {
  const c = new Carrier(), [a, x] = [device('a'), device('x')] as [Device, Device]
  knows(a, 5, c); knows(x, 3, c)
  const before = c.log.length
  const t = meet(a, x, c); settle(c, [a, x])
  return {
    'contacts of a afterwards': contacts(a),
    'contacts of the stranger afterwards': contacts(x),
    'values of a\'s proof the stranger can read': readable(x),
    'values the stranger got from a (a holds 5 other contacts)': valuesOn(x, t),
    'documents the encounter put on other tuples than the fresh one': c.log.slice(before).filter((on) => on !== t).length,
  }
}

/** Two people with a relationship meet again, one device each. */
function again (): Row {
  const c = new Carrier(), [a, b] = [device('a'), device('b')] as [Device, Device]
  knows(a, 4, c)
  meet(a, b, c); settle(c, [a, b])
  const before = c.log.length
  meet(a, b, c)
  const apart = [contacts(a) - 4, contacts(b)]
  settle(c, [a, b])
  return {
    'contacts each holds of the other before the proofs arrive': apart.join(' and '),
    'after one delivery each way, a holds of b': contacts(a) - 4,
    'and b holds of a': contacts(b),
    'documents sent for it': c.log.length - before,
    'acts of the users': 0,
  }
}

/** A has a phone and a laptop; the laptop meets B again. `synced`: whether the laptop knows the relationship the phone made. */
function ownDevices (synced: boolean): Row {
  const c = new Carrier(), phone = device('phone'), laptop = device('laptop', phone), b = device('b')
  meet(phone, b, c); settle(c, [phone, b])
  if (synced) sync(c, [phone, laptop])
  meet(laptop, b, c); settle(c, [laptop, b])
  const first = { laptop: contacts(laptop), b: contacts(b) }
  const late = sync(c, [phone, laptop])
  const afterSync = { phone: contacts(phone), laptop: contacts(laptop) }
  settle(c, [b, phone])
  return {
    'right after the encounter the laptop holds of b': first.laptop,
    'and b holds of a': first.b,
    'after a\'s devices synced, the phone holds of b': afterSync.phone,
    'and the laptop': afterSync.laptop,
    'documents a sent after the sync': late,
    'then b holds of a': contacts(b),
    'another meeting was needed': false,
  }
}

/** Both have two devices; A's phone meets B's phone while A's laptop meets B's laptop, all four apart. */
function crossed (): Row {
  const c = new Carrier(), a1 = device('a1'), a2 = device('a2', a1), b1 = device('b1'), b2 = device('b2', b1)
  meet(a1, b1, c); meet(a2, b2, c); settle(c, [a1, a2, b1, b2])
  sync(c, [a1, a2])
  const aAlone = contacts(a1)
  settle(c, [b1, b2])
  const bBefore = Math.max(contacts(b1), contacts(b2))
  sync(c, [b1, b2])
  const bAfter = [contacts(b1), contacts(b2)]
  settle(c, [a1, a2]); sync(c, [a1, a2])
  return {
    'after a\'s devices synced, a holds of b': aAlone,
    'b\'s devices, before they synced, each hold of a': bBefore,
    'after b\'s devices synced, b holds of a': bAfter.join(' and '),
    'then a holds of b': [contacts(a1), contacts(a2)].join(' and '),
    'another meeting was needed': false,
  }
}

/** A's phone and laptop, apart, each meet a different person. */
function twoStrangersApart (): Row {
  const c = new Carrier(), phone = device('phone'), laptop = device('laptop', phone), x = device('x'), y = device('y')
  const tx = meet(phone, x, c), ty = meet(laptop, y, c); settle(c, [phone, laptop, x, y])
  const before = [valuesOn(x, tx), valuesOn(y, ty)]
  const late = sync(c, [phone, laptop]); settle(c, [x, y])
  return {
    'contacts of a afterwards': [contacts(phone), contacts(laptop)].join(' and '),
    'documents a sent after the sync': late,
    'values in it': valuesOn(x, tx) + valuesOn(y, ty) - before[0]! - before[1]!,
    'values of it the two strangers can read': readable(x) + readable(y),
  }
}

/** What a stranger gets from someone with one device and from someone whose two devices each met somebody apart. */
function secondDocument (): Row {
  const c = new Carrier(), one = device('one'), phone = device('phone'), laptop = device('laptop', phone), x = device('x'), y = device('y'), z = device('z')
  const t1 = meet(one, x, c), t2 = meet(phone, y, c); meet(laptop, z, c); settle(c, [one, phone, laptop, x, y, z])
  catchUp(one, c); sync(c, [phone, laptop]); settle(c, [x, y, z])
  const shape = (d: Device, t: string): string => [...d.got.values()].filter((p) => p.on === t).map((p) => p.tags.length).join(' and ')
  return {
    'documents the stranger holds from the person with one device, by values': shape(x, t1),
    'and from the person with two devices that met someone else apart': shape(y, t2),
    'values of all of it either stranger can read': readable(x) + readable(y),
  }
}

/** A re-encounter where A's proof is lost on the way; the device that sent it is gone, its sibling sends it again. */
function lost (): Row {
  const c = new Carrier(), a1 = device('a1'), a2 = device('a2', a1), b = device('b')
  meet(a1, b, c); settle(c, [a1, b]); sync(c, [a1, a2])
  c.drop = 1                                               // a1's proof on the fresh tuple
  meet(a1, b, c); settle(c, [a1, b])
  const oneSided = [contacts(a1), contacts(b)]
  share(a1, a2)                                            // a2 learns what a1 sent, and that nothing came back for it
  const again = sendAgain(a2, c); settle(c, [b])
  return {
    'with a\'s proof lost, a holds of b': oneSided[0] as number,
    'and b holds of a': oneSided[1] as number,
    'documents the sibling sends again': again,
    'then b holds of a': contacts(b),
  }
}

/** A device fetches the other side's proof and is lost before it shares it. */
function fetchedAndLost (): Row {
  const c = new Carrier(), a1 = device('a1'), a2 = device('a2', a1), b = device('b')
  meet(a1, b, c); settle(c, [a1, b]); sync(c, [a1, a2])
  meet(a2, b, c); receive(b, c)
  share(a2, a1); receive(a1, c)                            // a1 fetches b's proof for the fresh tuple; then a1 is gone
  for (let i = 0; i < 3; i++) { catchUp(a2, c); sendAgain(a2, c); catchUp(b, c); sendAgain(b, c); settle(c, [a2, b]) }   // both sides send all they owe
  const stuck = [contacts(a2), contacts(b)]
  meet(a2, b, c); settle(c, [a2, b])                       // the next encounter
  return {
    'after both sides sent all they owe, a\'s remaining device holds of b': stuck[0] as number,
    'and b holds of a': stuck[1] as number,
    'after the next encounter a holds of b': contacts(a2),
  }
}

/** B, who shares a tuple with A, hands in a value on a tuple of A with someone else. */
function onAForeignTuple (): Row {
  const c = new Carrier(), [a, b, y] = [device('a'), device('b'), device('y')] as [Device, Device, Device]
  const x = meet(a, b, c), t = meet(a, y, c); settle(c, [a, b, y])
  forge(c, endOf(b, x), { id: t, from: endOf(y, t).side }); receive(a, c)
  return { 'a counts the other person as b': relationships(a).some((g) => g.includes(x) && g.includes(t)), 'contacts of a': contacts(a) }
}

/** A's phone and laptop know B and C; then the two devices scan each other. */
function ownDevicesScan (): Row {
  const c = new Carrier(), phone = device('phone'), laptop = device('laptop', phone), b = device('b'), d = device('c')
  meet(phone, b, c); meet(phone, d, c); settle(c, [phone, b, d]); sync(c, [phone, laptop])
  const before = contacts(phone)
  meet(phone, laptop, c); settle(c, [phone, laptop]); sync(c, [phone, laptop]); settle(c, [phone, laptop, b, d])
  return { 'contacts before': before, 'contacts of other people afterwards': relationships(phone).filter((g) => g.length === 1).length - 1, 'b and c fell into one': contacts(phone) < 3 }
}

/** Someone copied one end of a tuple of B's relationship with A and meets A as a new contact. `which`: the head of the relationship, or a tuple behind it. */
function copied (which: 'the head' | 'an older tuple'): Row {
  const c = new Carrier(), [a, b, thief] = [device('a'), device('b'), device('thief')] as [Device, Device, Device]
  const t1 = meet(a, b, c); settle(c, [a, b]); const t2 = meet(a, b, c); settle(c, [a, b])
  const h = headOf(a, t1), old = h === t1 ? t2 : t1
  const stolen = { ...endOf(b, which === 'the head' ? h : old) }
  const t = meet(a, thief, c), mine = endOf(thief, t)
  forge(c, stolen, { id: t, from: mine.side, key: mine.key }); settle(c, [a, thief])
  return { 'a counts the newcomer as b': relationships(a).some((g) => g.includes(t1) && g.includes(t)), 'contacts of a': contacts(a) }
}

/** B lost everything and meets A with a new device. */
function dataLoss (): Row {
  const c = new Carrier(), [a, b, bNew] = [device('a'), device('b'), device('b-new')] as [Device, Device, Device]
  meet(a, b, c); settle(c, [a, b])
  meet(a, bNew, c); settle(c, [a, bNew])
  return { 'a holds of b': contacts(a), 'b holds of a': contacts(bNew) }
}

/** A sends the same proof twice. */
function repeated (): Row {
  const c = new Carrier(), [a, x] = [device('a'), device('x')] as [Device, Device]
  knows(a, 5, c)
  const before = c.log.length
  const t = meet(a, x, c)
  sendAgain(a, c)                                          // nothing acknowledged yet: it goes out again
  receive(x, c)
  return {
    'documents a handed in on the fresh tuple': c.log.slice(before).filter((on) => on === t).length - 1,
    'different documents the stranger holds afterwards': [...x.got.values()].filter((d) => d.on === t).length,
    'different values it holds': new Set([...x.got.values()].filter((d) => d.on === t).flatMap((d) => d.tags)).size,
  }
}

/** Three people with 3, 3 and 2 devices; encounters, deliveries and syncs of single pairs of devices in random order, nothing lost; then everything delivered and synced. */
function randomSchedules (runs: number): Row {
  let wrong = 0, false_ = 0
  for (let r = 0; r < runs; r++) {
    const c = new Carrier()
    const a = [device('a1')]; a.push(device('a2', a[0]), device('a3', a[0]))
    const b = [device('b1')]; b.push(device('b2', b[0]), device('b3', b[0]))
    const x = [device('x1')]; x.push(device('x2', x[0]))
    const people = [a, b, x], all = [...a, ...b, ...x]
    const pick = <T>(xs: T[]): T => xs[randomInt(xs.length)] as T
    for (let i = 0; i < 14; i++) {
      const k = randomInt(4)
      if (k === 0) { const p = pick(people), q = pick(people.filter((o) => o !== p)); meet(pick(p), pick(q), c) } else if (k === 1) receive(pick(all), c)
      else if (k === 2) { const p = pick(people), d1 = pick(p), d2 = pick(p.filter((o) => o !== d1)); share(d1, d2) } else { const d = pick(all); catchUp(d, c); sendAgain(d, c) }
    }
    for (let i = 0; i < 4; i++) { for (const p of people) { sync(c, p); for (const d of p) sendAgain(d, c) } settle(c, all) }
    for (const p of people) sync(c, p)
    // every device of a person must show one contact per other person it shares a tuple with, and no tuple with two people in one contact
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
    }
  }
  return { runs, 'devices that show more or fewer contacts than people they know': wrong, 'contacts that hold tuples of two people': false_ }
}

/** What one encounter costs someone with many contacts. */
function cost (n: number): Row {
  const c = new Carrier(), [a, x] = [device('a'), device('x')] as [Device, Device]
  knows(a, n, c)
  const before = c.log.length
  const t = meet(a, x, c); settle(c, [a, x])
  return { 'values a sends on the fresh tuple': valuesOn(x, t), 'documents on other tuples': c.log.slice(before).filter((on) => on !== t).length, 'step of the filling': STEP }
}

export const measure = (): Record<string, Row> => ({
  'two strangers meet': strangers(),
  'two who know each other meet again': again(),
  'a\'s laptop, which knows the relationship, meets b again': ownDevices(true),
  'a\'s laptop, which has not heard of the relationship yet, meets b again': ownDevices(false),
  'both have two devices and meet crosswise, all four apart': crossed(),
  'a\'s two devices, apart, each meet someone else': twoStrangersApart(),
  'the second document of every tuple': secondDocument(),
  'one proof is lost on the way': lost(),
  'a device fetches the other side\'s proof and is lost before it shares it': fetchedAndLost(),
  'a contact hands in a value on a tuple that is not its own': onAForeignTuple(),
  'a\'s own devices scan each other': ownDevicesScan(),
  'a copied key of the head of a relationship': copied('the head'),
  'a copied key of an older tuple of a relationship': copied('an older tuple'),
  'b lost everything': dataLoss(),
  'the same proof sent twice': repeated(),
  'random schedules': randomSchedules(60),
  'cost with 300 contacts': cost(300),
})
