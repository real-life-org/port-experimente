// A model for one question: can two people who meet again end up as one
// contact on every device, with no act of the user?
//
// Not the library. A small model of the 0.32 inventory of Trust 6a
// (candidates fixed at the opening, union as a set, a duty per pair that
// stands until the other side has booked it) with two changes:
//
//   1. The probe carries the proof. Where the probe of 6a names a blinded
//      anchor per candidate, it carries a value under the secrets of both
//      tuples, bound to the end the prover holds in each. A side that can
//      make a value itself, for a pair it admits, unites the two tuples at
//      once. There is no hit and nothing a mere anchor could trigger.
//   2. Tuples that two own devices opened apart are candidates for each
//      other, if both are heads when a device of the person first holds
//      both. That device writes it down, and the person owes the proof for
//      the pair from then on.
//
// What stays from the inventory: a side that united a pair owes its own
// proof for that pair as a document of its own (the mapping), until the
// other side acknowledges it; and the other side acknowledges only when it
// has verified and booked it. A device that cannot read a mapping does
// not acknowledge, and the sender tries again. Nothing unread is kept.
//
// A device holds facts (ends of tuples, what the opening device knew,
// late candidates, unions, duties and their discharge), and facts only
// add up.
import { createHash, createHmac, randomBytes } from 'node:crypto'

export type Side = 'a' | 'b'
/** One end of a tuple: the tuple's name, the secret both ends share, and which end this is. */
export type End = { id: string, key: string, side: Side }
/** A probe (values for pairs {x, on}, filled up) or a mapping (one value), sent on `on` by the end `from`. */
export type Doc = { id: string, kind: 'probe' | 'map', on: string, from: Side, tags: string[] }
/** What the opening device held when it opened a tuple: the tuples it knew, and which of them were heads of their relationships then. */
export type Opening = { known: string[], heads: string[] }
export type Device = {
  name: string
  person: string                   // a secret of the person, the same on all its devices
  ends: Map<string, End>           // by `${id}/${side}`
  opened: Map<string, Opening>     // by `${id}/${side}`
  late: Set<string>                // pairs opened apart that were both heads when first held together
  united: Set<string>              // pairs of tuples this person united
  probes: Map<string, { on: string, xs: string[] }>   // probes this person sent, by name
  owed: Set<string>                // pairs this person owes its own proof for
  done: Set<string>                // of those, the ones the other side booked
  seen: Set<string>                // not a fact: pairs this device has looked at for `late`
}
/** A device; `of` makes it a further device of the same person. */
export const device = (name: string, of?: Device): Device => ({ name, person: of?.person ?? randomBytes(16).toString('hex'), ends: new Map(), opened: new Map(), late: new Set(), united: new Set(), probes: new Map(), owed: new Set(), done: new Set(), seen: new Set() })

const other = (s: Side): Side => (s === 'a' ? 'b' : 'a')
const endKey = (id: string, side: Side): string => `${id}/${side}`
const pairOf = (x: string, y: string): string => (x < y ? `${x}|${y}` : `${y}|${x}`)
const mac = (key: string, msg: unknown): string => createHmac('sha256', key).update(JSON.stringify(msg)).digest('base64url')
const name = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)
/** The value for the pair {x, y}: under both secrets, bound to the end the prover holds in x and in y, and to the kind of document. */
export const tag = (kind: Doc['kind'], x: Pick<End, 'id' | 'key'>, proverInX: Side, y: Pick<End, 'id' | 'key'>, proverInY: Side): string => mac(mac(x.key, y.key), [kind, x.id, proverInX, y.id, proverInY]).slice(0, 43)
/** A probe is filled up to the next multiple of this (Trust 6760). */
export const STEP = 256

/** One mailbox per tuple and end, open to anyone who knows the name. What
 *  a device fetched is gone from the box. The carrier tells the sender's
 *  side that a probe was fetched; for a mapping it passes on the receiver's
 *  acknowledgement, which the receiver gives only when it booked it. A
 *  fault drops the next documents handed in. */
export class Carrier {
  private boxes = new Map<string, Doc[]>()
  drop = 0
  /** Every document handed in, in order. */
  log: Doc[] = []
  fetched = new Set<string>()
  acked = new Set<string>()
  put (to: Side, d: Doc): void {
    this.log.push(d)
    if (this.drop > 0) { this.drop--; return }
    const k = `${d.on}:${to}`
    this.boxes.set(k, [...(this.boxes.get(k) ?? []), d])
  }
  fetch (e: End): Doc[] { const k = `${e.id}:${e.side}`, out = this.boxes.get(k) ?? []; this.boxes.delete(k); for (const d of out) this.fetched.add(d.id); return out }
}

/** A tuple whose two ends are one person's: its own devices scanned each other. It proves nothing and nothing is proved on it. */
const own = (dev: Device, id: string): boolean => dev.ends.has(endKey(id, 'a')) && dev.ends.has(endKey(id, 'b'))
const endsOf = (dev: Device): End[] => [...dev.ends.values()].filter((e) => !own(dev, e.id))
const endOf = (dev: Device, id: string): End | undefined => endsOf(dev).find((e) => e.id === id)

/** What a device shows: its tuples grouped into relationships, from the unions it holds. */
export function relationships (dev: Device): string[][] {
  const ids = [...new Set([...dev.ends.values()].map((e) => e.id))]
  const parent = new Map<string, string>(ids.map((k) => [k, k]))
  const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r) as string; return r }
  for (const p of dev.united) { const [x, y] = p.split('|') as [string, string]; if (parent.has(x) && parent.has(y)) parent.set(find(x), find(y)) }
  const groups = new Map<string, string[]>()
  for (const k of ids) groups.set(find(k), [...(groups.get(find(k)) ?? []), k])
  return [...groups.values()].map((g) => g.sort()).sort((p, q) => (p[0] as string < (q[0] as string) ? -1 : 1))
}
export const contacts = (dev: Device): number => relationships(dev).length
/** The head of a relationship: one of its tuples, the same on every device that holds the same unions (here: the largest name). */
const head = (group: string[]): string => group[group.length - 1] as string
/** The head of the relationship the tuple `id` belongs to on this device. */
export const headOf = (dev: Device, id: string): string => head(relationships(dev).find((g) => g.includes(id)) as string[])

function probe (dev: Device, on: End, xs: End[]): Doc {
  const tags = xs.map((x) => tag('probe', x, x.side, on, on.side))
  for (let i = 0; tags.length === 0 || tags.length % STEP; i++) tags.push(mac(dev.person, ['fill', on.id, on.side, i]).slice(0, 43))
  tags.sort()
  return { id: name(['probe', on.id, on.side, tags]), kind: 'probe', on: on.id, from: on.side, tags }
}
/** The person's own proof for a pair, as a document of its own: on the tuple of the larger name. The same bytes on every device. */
function mapping (dev: Device, pair: string): Doc | undefined {
  const [p, q] = pair.split('|') as [string, string], x = endOf(dev, p), on = endOf(dev, q)
  if (!x || !on) return undefined
  const t = tag('map', x, x.side, on, on.side)
  return { id: name(['map', on.id, on.side, t]), kind: 'map', on: on.id, from: on.side, tags: [t] }
}

/** Change 2: a device looks once at every pair of tuples it holds whose
 *  openings did not know of each other. If both are heads now, they are
 *  candidates for each other from here on, and the person owes the proof. */
function notice (dev: Device): void {
  const all = endsOf(dev), groupHead = new Map<string, string>()
  for (const g of relationships(dev)) for (const id of g) groupHead.set(id, head(g))
  for (const x of all) for (const y of all) {
    const p = pairOf(x.id, y.id)
    if (x.id >= y.id || dev.seen.has(p)) continue
    const ox = dev.opened.get(endKey(x.id, x.side)), oy = dev.opened.get(endKey(y.id, y.side))
    if (!ox || !oy) continue
    dev.seen.add(p)
    if (ox.known.includes(y.id) || oy.known.includes(x.id)) continue
    if (groupHead.get(x.id) === x.id && groupHead.get(y.id) === y.id) { dev.late.add(p); dev.owed.add(p) }
  }
}

/** Whether this person admits the pair {x, y} of its ends: one was a head
 *  when the other was opened (Trust 2300, 6802, 6960), or the pair is
 *  written down as opened apart. */
export function admits (dev: Device, x: End, y: End): boolean {
  const ox = dev.opened.get(endKey(x.id, x.side)), oy = dev.opened.get(endKey(y.id, y.side))
  return Boolean(ox?.heads.includes(y.id) || oy?.heads.includes(x.id) || dev.late.has(pairOf(x.id, y.id)))
}

/** An encounter (or any other way a fresh tuple comes about): both devices
 *  hold an end of a new tuple, each writes down what it knew then, and each
 *  sends, on the fresh tuple, a probe with a value for every head it holds
 *  (Trust 6750). With no head a full step of filling goes out all the same. */
export function meet (d1: Device, d2: Device, c: Carrier): string {
  const id = 't-' + randomBytes(5).toString('hex'), key = randomBytes(32).toString('base64url')
  for (const [d, side] of [[d1, 'a'], [d2, 'b']] as const) {
    const all = endsOf(d), e: End = { id, key, side }
    const heads = all.filter((x) => headOf(d, x.id) === x.id)
    d.opened.set(endKey(id, side), { known: all.map((x) => x.id).sort(), heads: heads.map((x) => x.id).sort() })
    d.ends.set(endKey(id, side), e)
    for (const x of all) d.seen.add(pairOf(x.id, id))
    const doc = probe(d, e, heads)
    d.probes.set(doc.id, { on: endKey(id, side), xs: heads.map((x) => endKey(x.id, x.side)) })
    c.put(other(side), doc)
  }
  return id
}

/** A device sends what its person owes: probes the carrier has not said
 *  were fetched, and its own proof for every pair it owes one for and the
 *  other side has not booked. Any device of the person can: it makes the
 *  same bytes. Returns how many documents went out. */
export function send (dev: Device, c: Carrier): number {
  let docs = 0
  for (const [id, s] of dev.probes) {
    if (c.fetched.has(id)) continue
    const on = dev.ends.get(s.on), xs = s.xs.map((k) => dev.ends.get(k))
    if (on && xs.every((x) => x)) { c.put(other(on.side), probe(dev, on, xs as End[])); docs++ }
  }
  for (const p of dev.owed) {
    const d = mapping(dev, p)
    if (!d) continue
    if (c.acked.has(d.id)) { dev.done.add(p); continue }
    if (!dev.done.has(p)) { c.put(other(d.from), d); docs++ }
  }
  return docs
}

/** A device fetches what waits on its ends and reads it with the ends it
 *  holds. A value it can make itself, for a pair it admits, unites the two
 *  tuples; the person then owes its own proof for the pair. A mapping is
 *  acknowledged if and only if that happened, or the two tuples are one
 *  relationship here already. Nothing is kept. */
export function receive (dev: Device, c: Carrier): void {
  for (const on of endsOf(dev)) for (const d of c.fetch(on)) {
    const tags = new Set(d.tags)
    for (const x of endsOf(dev)) {
      if (x.id === on.id) continue
      const ok = admits(dev, x, on), joined = headOf(dev, x.id) === headOf(dev, on.id)
      if ((!ok && !joined) || !tags.has(tag(d.kind, x, other(x.side), on, d.from))) continue
      const p = pairOf(x.id, on.id)
      if (ok) { dev.united.add(p); dev.owed.add(p) }
      if (d.kind === 'map') c.acked.add(d.id)                // booked, or the two are one relationship here already (Trust 6975.3)
    }
  }
  for (const p of dev.owed) { const d = mapping(dev, p); if (d && c.acked.has(d.id)) dev.done.add(p) }
}

/** The person's own devices sync: facts only, and facts only add up. */
export function share (from: Device, to: Device): void {
  for (const [k, v] of from.ends) to.ends.set(k, v)
  for (const [k, v] of from.opened) to.opened.set(k, v)
  for (const [k, v] of from.probes) to.probes.set(k, v)
  for (const f of ['late', 'united', 'owed', 'done'] as const) for (const k of from[f]) to[f].add(k)
  notice(to)
}

/** How many values of a document a device can make itself. */
export function readable (dev: Device, d: Doc): number {
  const on = dev.ends.get(endKey(d.on, other(d.from)))
  return on ? endsOf(dev).filter((x) => x.id !== on.id && d.tags.includes(tag(d.kind, x, other(x.side), on, d.from))).length : 0
}
/** What someone can hand in who holds a copy of one end `x` and, if at all,
 *  the secret of the tuple it writes on: a value for the pair, on that
 *  tuple, as the end `from`. Without the secret it uses one of its own. */
export function forge (c: Carrier, kind: Doc['kind'], x: End, on: { id: string, from: Side, key?: string }): void {
  const t = tag(kind, x, x.side, { id: on.id, key: on.key ?? randomBytes(32).toString('base64url') }, on.from)
  c.put(other(on.from), { id: randomBytes(8).toString('hex'), kind, on: on.id, from: on.from, tags: [t] })
}
/** An image of a device as it is now, to restore it from later. */
export const image = (dev: Device): Device => ({ ...dev, ends: new Map(dev.ends), opened: new Map(dev.opened), late: new Set(dev.late), united: new Set(dev.united), probes: new Map(dev.probes), owed: new Set(dev.owed), done: new Set(dev.done), seen: new Set(dev.seen) })
