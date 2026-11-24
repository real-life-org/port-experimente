// Scenarios for the model of model.ts: the cases the probe of Trust 6a
// needed rules of their own for, each as plain facts. A measurement of the
// model, not of the library.
import { Carrier, STEP, catchUp, contacts, device, forge, meet, readable, receive, relationships, resend, retire, share, type Device } from './model'

export type Row = Record<string, string | number | boolean>
const settle = (c: Carrier, devs: Device[]): void => { for (const d of devs) receive(d, c) }
/** The person's devices sync with each other, and each then proves what its person has not proved yet. */
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

/** Two people who never met; both have other contacts. */
function strangers (): Row {
  const c = new Carrier(), [a, x] = [device('a'), device('x')] as [Device, Device]
  knows(a, 5, c); knows(x, 3, c)
  const before = c.log.length
  const t = meet(a, x, c); settle(c, [a, x])
  return {
    'contacts of a afterwards': contacts(a),
    'contacts of the stranger afterwards': contacts(x),
    'tags of a\'s proof the stranger can read': readable(x),
    'tags the stranger got from a (a holds 5 other contacts)': [...x.got.values()].filter((p) => p.on === t).reduce((n, p) => n + p.tags.length, 0),
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
  const c = new Carrier(), [phone, laptop, b] = [device('phone'), device('laptop'), device('b')] as [Device, Device, Device]
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
  const c = new Carrier(), [a1, a2, b1, b2] = [device('a1'), device('a2'), device('b1'), device('b2')] as [Device, Device, Device, Device]
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
  const c = new Carrier(), [phone, laptop, x, y] = [device('phone'), device('laptop'), device('x'), device('y')] as [Device, Device, Device, Device]
  meet(phone, x, c); meet(laptop, y, c); settle(c, [phone, laptop, x, y])
  const late = sync(c, [phone, laptop]); settle(c, [x, y])
  return {
    'contacts of a afterwards': [contacts(phone), contacts(laptop)].join(' and '),
    'documents a sent after the sync': late,
    'tags of them the two strangers can read': readable(x) + readable(y),
  }
}

/** A re-encounter where one side's proof is lost on the way. */
function lost (): Row {
  const c = new Carrier(), [a, b] = [device('a'), device('b')] as [Device, Device]
  meet(a, b, c); settle(c, [a, b])
  c.drop = 1                                               // a's proof on the fresh tuple
  const t = meet(a, b, c); settle(c, [a, b])
  const oneSided = [contacts(a), contacts(b)]
  resend(a, c, t); settle(c, [b])
  return {
    'with a\'s proof lost, a holds of b': oneSided[0] as number,
    'and b holds of a': oneSided[1] as number,
    'after it was sent again, b holds of a': contacts(b),
  }
}

/** Someone copied the secret of a tuple of B and meets A as a new contact. `retired`: A and B gave that key up before. */
function copied (retired: boolean): Row {
  const c = new Carrier(), [a, b, thief] = [device('a'), device('b'), device('thief')] as [Device, Device, Device]
  const old = meet(a, b, c); settle(c, [a, b])
  const stolen = { ...(b.tuples.get(old) as NonNullable<ReturnType<typeof b.tuples.get>>) }
  if (retired) { meet(a, b, c); settle(c, [a, b]); retire(a, old); retire(b, old) }   // a fresh tuple took its place
  const t = meet(a, thief, c)
  forge(c, stolen, thief.tuples.get(t) as NonNullable<ReturnType<typeof thief.tuples.get>>); settle(c, [a, thief])
  const withB = relationships(a).find((g) => g.includes(old)) as string[]
  return {
    'a counts the newcomer as b': withB.includes(t),
    'contacts of a': contacts(a),
  }
}

/** B lost everything and meets A with a new device. */
function dataLoss (): Row {
  const c = new Carrier(), [a, b, bNew] = [device('a'), device('b'), device('b-new')] as [Device, Device, Device]
  meet(a, b, c); settle(c, [a, b])
  meet(a, bNew, c); settle(c, [a, bNew])
  return { 'a holds of b': contacts(a), 'b holds of a': contacts(bNew) }
}

/** The same facts in another order of arrival give the same picture. */
function anyOrder (): Row {
  const c = new Carrier(), [a1, a2, b] = [device('a1'), device('a2'), device('b')] as [Device, Device, Device]
  meet(a1, b, c); meet(a2, b, c); meet(a1, b, c); settle(c, [a1, a2, b]); sync(c, [a1, a2]); settle(c, [b, a1, a2]); sync(c, [a1, a2])
  const turned = device('turned')
  for (const [k, v] of [...a1.tuples].reverse()) turned.tuples.set(k, v)
  for (const [k, v] of [...a1.got].reverse()) turned.got.set(k, v)
  return {
    'a holds of b': contacts(a1),
    'a device that got the same facts in the opposite order shows the same': JSON.stringify(relationships(turned)) === JSON.stringify(relationships(a1)),
  }
}

/** What one encounter costs someone with many contacts. */
function cost (n: number): Row {
  const c = new Carrier(), [a, x] = [device('a'), device('x')] as [Device, Device]
  knows(a, n, c)
  const before = c.log.length
  const t = meet(a, x, c); settle(c, [a, x])
  const tags = [...x.got.values()].filter((p) => p.on === t).reduce((k, p) => k + p.tags.length, 0)
  return { 'tags a sends on the fresh tuple': tags, 'bytes of them (22 characters each)': tags * 22, 'documents on other tuples': c.log.slice(before).filter((on) => on !== t).length, 'step of the filling': STEP }
}

export const measure = (): Record<string, Row> => ({
  'two strangers meet': strangers(),
  'two who know each other meet again': again(),
  'a\'s laptop, which knows the relationship, meets b again': ownDevices(true),
  'a\'s laptop, which has not heard of the relationship yet, meets b again': ownDevices(false),
  'both have two devices and meet crosswise, all four apart': crossed(),
  'a\'s two devices, apart, each meet someone else': twoStrangersApart(),
  'one proof is lost on the way': lost(),
  'a copied key that is still in use': copied(false),
  'a copied key that was given up': copied(true),
  'b lost everything': dataLoss(),
  'order of arrival': anyOrder(),
  'cost with 200 contacts': cost(200),
})
