// A model for one question: can two people who meet again end up as one
// contact on every device, with no act of the user, by one rule?
//
// Not the library. A small model of a candidate that replaces the probe,
// the hit, the mapping and the duty per pair of tuples (Trust 6a) by one
// document and three sentences:
//
//   1. Each side proves every pair of its tuples once. The proof for the
//      pair {x, y} is a value under the secrets of both tuples, bound to
//      the end the prover holds in each, and it travels on y. Only someone
//      who holds the other end of x and the other end of y can check it; to
//      anyone else it is a random value. For a fresh tuple the proofs go out
//      on that tuple, for every tuple the side holds then; for a pair it
//      learns of later (a sibling device made the other tuple), when it
//      learns of it. Every tuple gets a second document some time after
//      its first, whether or not there is anything more to prove: so its
//      coming says nothing.
//   2. A side that holds the other side's proof for a pair unites the two
//      tuples, if on its own side the tuple the proof stands under is the
//      head of its relationship (or the two are united already). The sender
//      proves with all it holds; the receiver decides by what it knows. The
//      union is a fact: the person's devices share it, and nothing takes it
//      back.
//   3. A proof is owed until the carrier says the other side has it. Any
//      device of the person can send it: it is the same document, byte for
//      byte.
//
// There is no answer to a proof, no number and no chooser. A device holds
// facts (ends of tuples, documents received, unions, documents sent and
// acknowledged), and facts only add up.
import { createHash, createHmac, randomBytes } from 'node:crypto'

export type Side = 'a' | 'b'
/** One end of a tuple: the tuple's name, the secret both ends share, and which end this is. */
export type End = { id: string, key: string, side: Side }
/** Values for pairs {x, on}, sent on `on` by the end `from`; filled up and sorted. Its name follows from its content. */
export type Doc = { id: string, on: string, from: Side, tags: string[] }
/** What a person sent: on which end, for which ends, as which document of that tuple (0 the first, 1 the second, …). Enough for a sibling to make the same document again. */
export type Sent = { on: string, xs: string[], n: number }
export type Device = {
  name: string
  person: string                   // a secret of the person, the same on all its devices
  ends: Map<string, End>           // by `${id}/${side}`
  got: Map<string, Doc>            // documents received, readable or not
  united: Set<string>              // pairs of tuples this person united
  sent: Map<string, Sent>          // documents this person sent, by name
  acked: Set<string>               // of those, the ones the carrier says the other side holds
  read: Map<string, boolean>       // not a fact: which value of which document this device could make, so that it computes none twice
}
/** A device; `of` makes it a further device of the same person. */
export const device = (name: string, of?: Device): Device => ({ name, person: of?.person ?? randomBytes(16).toString('hex'), ends: new Map(), got: new Map(), united: new Set(), sent: new Map(), acked: new Set(), read: new Map() })

const other = (s: Side): Side => (s === 'a' ? 'b' : 'a')
const endKey = (id: string, side: Side): string => `${id}/${side}`
const pairOf = (x: string, y: string): string => (x < y ? `${x}|${y}` : `${y}|${x}`)
const mac = (key: string, msg: unknown): string => createHmac('sha256', key).update(JSON.stringify(msg)).digest('base64url')
/** The value for the pair {x, y}: under both secrets, bound to the end the prover holds in x and in y. */
export const tag = (x: Pick<End, 'id' | 'key'>, proverInX: Side, y: Pick<End, 'id' | 'key'>, proverInY: Side): string => mac(mac(x.key, y.key), ['proof', x.id, proverInX, y.id, proverInY]).slice(0, 43)
/** Values are filled up to the next multiple of this (Trust 6760 fills to 256) and sorted. */
export const STEP = 256

/** One mailbox per tuple and end, open to anyone who knows the name: the
 *  carrier does not know who hands a document in. What a device fetched is
 *  gone from the box, and the carrier tells the sender's side that it was
 *  fetched. A fault drops the next documents handed in. */
export class Carrier {
  private boxes = new Map<string, Doc[]>()
  drop = 0
  /** The tuple of every document handed in, in order. */
  log: string[] = []
  /** Names of the documents a receiving device fetched. */
  kept = new Set<string>()
  put (to: Side, d: Doc): void {
    this.log.push(d.on)
    if (this.drop > 0) { this.drop--; return }
    const k = `${d.on}:${to}`
    this.boxes.set(k, [...(this.boxes.get(k) ?? []), d])
  }
  fetch (e: End): Doc[] { const k = `${e.id}:${e.side}`, out = this.boxes.get(k) ?? []; this.boxes.delete(k); for (const d of out) this.kept.add(d.id); return out }
}

/** A tuple whose two ends are one person's: its own devices scanned each other. It proves nothing and nothing is proved on it. */
const own = (dev: Device, id: string): boolean => dev.ends.has(endKey(id, 'a')) && dev.ends.has(endKey(id, 'b'))
const endsOf = (dev: Device): End[] => [...dev.ends.values()].filter((e) => !own(dev, e.id))

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
const heads = (dev: Device): Set<string> => new Set(relationships(dev).map(head))

/** The document for the pairs {x, on}: the values, filled up with values
 *  derived from the person's secret, so that every device of the person
 *  makes the same bytes and a repeat shows nothing a first sending did not. */
function make (dev: Device, on: End, xs: End[], n: number): Doc {
  const tags = xs.map((x) => tag(x, x.side, on, on.side))
  const names = xs.map((x) => endKey(x.id, x.side)).sort()
  for (let i = 0; tags.length === 0 || tags.length % STEP; i++) tags.push(mac(dev.person, ['fill', on.id, on.side, names, n, i]).slice(0, 43))
  tags.sort()
  return { id: createHash('sha256').update(JSON.stringify([on.id, on.side, tags])).digest('hex').slice(0, 16), on: on.id, from: on.side, tags }
}
/** How many documents this person sent on the end `on`. */
const sentOn = (dev: Device, on: End): number => [...dev.sent.values()].filter((v) => v.on === endKey(on.id, on.side)).length
function prove (dev: Device, c: Carrier, on: End, xs: End[]): void {
  const n = sentOn(dev, on), d = make(dev, on, xs, n)
  dev.sent.set(d.id, { on: endKey(on.id, on.side), xs: xs.map((x) => endKey(x.id, x.side)).sort(), n })
  c.put(other(on.side), d)
}
const proved = (dev: Device): Set<string> => { const s = new Set<string>(); for (const v of dev.sent.values()) for (const x of v.xs) s.add(pairOf(x.split('/')[0] as string, v.on.split('/')[0] as string)); return s }

/** An encounter (or any other way a fresh tuple comes about): both devices
 *  hold an end of a new tuple, and each proves, on it, every tuple it holds.
 *  With nothing to prove a full step of filling goes out all the same. */
export function meet (d1: Device, d2: Device, c: Carrier): string {
  const id = 't-' + randomBytes(5).toString('hex'), key = randomBytes(32).toString('base64url')
  for (const [d, side] of [[d1, 'a'], [d2, 'b']] as const) {
    const xs = endsOf(d), e: End = { id, key, side }
    d.ends.set(endKey(id, side), e)
    prove(d, c, e, xs)
  }
  return id
}

/** Sentence 3: a device sends again what its person sent and the carrier
 *  has not said the other side holds. Any device of the person can: it
 *  makes the same bytes. Returns how many documents went out. */
export function sendAgain (dev: Device, c: Carrier): number {
  let docs = 0
  for (const id of dev.sent.keys()) if (c.kept.has(id)) dev.acked.add(id)
  for (const [id, s] of dev.sent) {
    if (dev.acked.has(id)) continue
    const on = dev.ends.get(s.on), xs = s.xs.map((k) => dev.ends.get(k))
    if (on && xs.every((x) => x)) { c.put(other(on.side), make(dev, on, xs as End[], s.n)); docs++ }
  }
  return docs
}

/** Sentence 1, second half: a device sends the proofs its person has not
 *  sent yet, for pairs it learned of through a sync. The pair travels
 *  under the tuple of the smaller name on the tuple of the larger. And
 *  every tuple that has had one document only gets its second now, with
 *  those proofs or with filling alone. Returns how many documents went
 *  out. */
export function catchUp (dev: Device, c: Carrier): number {
  let docs = 0
  // owed: every pair of heads, and every pair this person united on the other side's proof without having proved it itself
  const hs = heads(dev), done = proved(dev)
  const all = endsOf(dev).sort((p, q) => (p.id < q.id ? -1 : 1))
  for (const on of all) {
    const xs = all.filter((x) => x.id < on.id && !done.has(pairOf(x.id, on.id)) && ((hs.has(x.id) && hs.has(on.id)) || dev.united.has(pairOf(x.id, on.id))))
    if (xs.length || sentOn(dev, on) < 2) { prove(dev, c, on, xs); docs++ }
  }
  return docs
}

/** Sentence 2. A device reads the documents it holds with the ends it
 *  holds: a value it can make itself, under an end whose tuple is the head
 *  of its relationship here, unites the two tuples. Until nothing changes. */
export function evaluate (dev: Device): void {
  const can = (d: Doc, tags: Set<string>, x: End, on: End): boolean => {
    const k = `${d.id}|${x.id}/${x.side}`
    let v = dev.read.get(k)
    if (v === undefined) { v = tags.has(tag(x, other(x.side), on, d.from)); dev.read.set(k, v) }
    return v
  }
  for (let changed = true; changed;) {
    changed = false
    const groupOf = new Map<string, string[]>()
    for (const g of relationships(dev)) for (const id of g) groupOf.set(id, g)
    for (const d of dev.got.values()) {
      const on = dev.ends.get(endKey(d.on, other(d.from)))
      if (!on || own(dev, on.id)) continue
      const tags = new Set(d.tags)
      for (const x of endsOf(dev)) {
        if (x.id === on.id || dev.united.has(pairOf(x.id, on.id)) || !can(d, tags, x, on)) continue
        const g = groupOf.get(x.id) as string[]
        if (head(g) !== x.id && !g.includes(on.id)) continue                  // only the head of a relationship proves something new
        dev.united.add(pairOf(x.id, on.id)); changed = true
      }
      if (changed) break
    }
  }
}

/** A device fetches what waits on its ends and keeps it, whether it can
 *  read it or not; it learns which of its person's documents the other
 *  side fetched; and it reads what it holds. */
export function receive (dev: Device, c: Carrier): void {
  for (const e of dev.ends.values()) for (const d of c.fetch(e)) dev.got.set(d.id, d)
  for (const id of dev.sent.keys()) if (c.kept.has(id)) dev.acked.add(id)
  evaluate(dev)
}

/** The person's own devices sync: facts only, and facts only add up. */
export function share (from: Device, to: Device): void {
  for (const [k, v] of from.ends) to.ends.set(k, v)
  for (const [k, v] of from.got) to.got.set(k, v)
  for (const k of from.united) to.united.add(k)
  for (const [k, v] of from.sent) to.sent.set(k, v)
  for (const k of from.acked) to.acked.add(k)
  evaluate(to)
}

/** How many values of all documents a device holds it can make itself. */
export function readable (dev: Device): number {
  let n = 0
  for (const d of dev.got.values()) { const on = dev.ends.get(endKey(d.on, other(d.from))); if (on) for (const x of endsOf(dev)) if (x.id !== on.id && d.tags.includes(tag(x, other(x.side), on, d.from))) n++ }
  return n
}
/** What someone can hand in who holds a copy of one end `x` and, if at all,
 *  the secret of the tuple it writes on: a value for the pair, on that
 *  tuple, as the end `from`. Without the secret it uses one of its own. */
export function forge (c: Carrier, x: End, on: { id: string, from: Side, key?: string }): void {
  const t = tag(x, x.side, { id: on.id, key: on.key ?? randomBytes(32).toString('base64url') }, on.from)
  c.put(other(on.from), { id: randomBytes(8).toString('hex'), on: on.id, from: on.from, tags: [t] })
}
/** The head of the relationship the tuple `id` belongs to on this device. */
export const headOf = (dev: Device, id: string): string => head(relationships(dev).find((g) => g.includes(id)) as string[])
