// A model for one question: can two people who meet again end up as one
// contact on every device, with no act of the user, by one rule?
//
// Not the library. A small model of a candidate that replaces the probe,
// the hit, the mapping and the duty per pair of tuples (Trust 6a) by one
// document and one rule:
//
//   - Two people who share a relationship share a secret per tuple (in the
//     protocol: the ECDH of the tuple's two pair keys). Here: a random key
//     both ends hold.
//   - A proof for a pair of own tuples {x, y} is a tag under the secret of x,
//     bound to y and to the direction it travels in, sent on y. Only the
//     other end of x can check it. To anyone else it is a random value.
//   - Each side sends one proof for every pair of tuples it holds, once:
//     for a fresh tuple on that tuple, for all it holds then; for a pair it
//     learns of later (a sibling device made the other tuple), when it
//     learns of it.
//   - A side unites two tuples when it holds the other side's proof for
//     them. That is all: no answer, no number, no state per pair.
//
// What a device holds is a set of facts (tuples, proofs received, pairs it
// proved, tuples retired); what it shows is computed from that set. Two
// devices with the same facts show the same, in whatever order the facts
// came.
import { createHmac, randomBytes } from 'node:crypto'

export type Side = 'a' | 'b'
/** One end of a tuple: its name, the secret both ends share, and which end this is. */
export type Tuple = { id: string, key: string, side: Side }
/** Tags for pairs {x, on}, each under the secret of an x, sent on `on` by the end `from`; padded. */
export type Proof = { id: string, on: string, from: Side, tags: string[] }
export type Device = {
  name: string
  tuples: Map<string, Tuple>
  got: Map<string, Proof>          // proofs received, as they came
  proved: Set<string>              // pairs this person sent a proof for
  retired: Map<string, string[]>   // tuples whose secret proves nothing new (a key that was changed or given up), each with the proofs held when it was retired
  lost?: boolean
}
export const device = (name: string): Device => ({ name, tuples: new Map(), got: new Map(), proved: new Set(), retired: new Map() })

const other = (s: Side): Side => (s === 'a' ? 'b' : 'a')
const pairOf = (x: string, y: string): string => (x < y ? `${x}|${y}` : `${y}|${x}`)
/** The tag for the pair {x, on}: under the secret of x, bound to `on` and to the end that sends it. */
export const tag = (x: Tuple, on: string, from: Side): string => createHmac('sha256', Buffer.from(x.key, 'base64url')).update(JSON.stringify(['proof', on, from])).digest('base64url').slice(0, 22)
/** Tags are filled up with random values to the next multiple of this, and sorted: the count is hidden up to the step. */
export const STEP = 8

/** One mailbox per tuple and end; what was fetched is gone. A fault drops the next documents put. */
export class Carrier {
  private boxes = new Map<string, Proof[]>()
  drop = 0
  /** The tuple of every document handed in, in order. */
  log: string[] = []
  put (to: Side, p: Proof): void {
    this.log.push(p.on)
    if (this.drop > 0) { this.drop--; return }
    const k = `${p.on}:${to}`
    this.boxes.set(k, [...(this.boxes.get(k) ?? []), p])
  }
  fetch (t: Tuple): Proof[] { const k = `${t.id}:${t.side}`, out = this.boxes.get(k) ?? []; this.boxes.delete(k); return out }
}

/** Sends, on the tuple `on`, the proofs for the pairs {x, on} of the given
 *  tuples. `always`: with nothing to prove, a full step of filling goes out
 *  all the same, so that "nobody yet" looks like "a few". */
function prove (dev: Device, c: Carrier, on: Tuple, xs: Tuple[], always = false): void {
  if (!xs.length && !always) return
  const tags = xs.map((x) => tag(x, on.id, on.side))
  while (tags.length === 0 || tags.length % STEP) tags.push(randomBytes(16).toString('base64url').slice(0, 22))
  tags.sort()
  c.put(other(on.side), { id: randomBytes(8).toString('hex'), on: on.id, from: on.side, tags })
  for (const x of xs) dev.proved.add(pairOf(x.id, on.id))
}

/** An encounter (or any other way a fresh tuple comes about): both devices
 *  hold a new tuple, and each proves, on it, every other tuple it holds. */
export function meet (d1: Device, d2: Device, c: Carrier): string {
  const id = 't-' + randomBytes(5).toString('hex'), key = randomBytes(32).toString('base64url')
  for (const [d, side] of [[d1, 'a'], [d2, 'b']] as const) {
    const t: Tuple = { id, key, side }
    const others = [...d.tuples.values()].filter((x) => !d.retired.has(x.id))
    d.tuples.set(id, t)
    prove(d, c, t, others, true)
  }
  return id
}

/** The second half of the one rule: a device sends the proofs for pairs
 *  its person has not proved yet. That happens after a sync brought a
 *  tuple a sibling made. The pair {x, y} travels under the secret of the
 *  smaller name on the tuple of the larger, so that sibling devices send
 *  the same thing. Returns how many documents went out. */
export function catchUp (dev: Device, c: Carrier): number {
  const ts = [...dev.tuples.values()].filter((t) => !dev.retired.has(t.id)).sort((p, q) => (p.id < q.id ? -1 : 1))
  let docs = 0
  for (const on of ts) {
    const xs = ts.filter((x) => x.id < on.id && !dev.proved.has(pairOf(x.id, on.id)))
    if (xs.length) { prove(dev, c, on, xs); docs++ }
  }
  return docs
}

/** Delivery's part, not this model's: a proof that was lost goes out again. */
export function resend (dev: Device, c: Carrier, on: string): void {
  const t = dev.tuples.get(on)
  if (t) prove(dev, c, t, [...dev.tuples.values()].filter((x) => x.id !== on && !dev.retired.has(x.id) && dev.proved.has(pairOf(x.id, on))), true)
}
/** What someone who copied the secret of one tuple can send on another. */
export function forge (c: Carrier, copied: Tuple, on: Tuple): void {
  c.put(other(on.side), { id: randomBytes(8).toString('hex'), on: on.id, from: on.side, tags: [tag(copied, on.id, on.side)] })
}

/** A device fetches what waits on its tuples and keeps it, whether it can read it or not. */
export function receive (dev: Device, c: Carrier): void {
  for (const t of dev.tuples.values()) for (const p of c.fetch(t)) dev.got.set(p.id, p)
}

/** The person's own devices sync: facts only, and facts only add up. */
export function share (from: Device, to: Device): void {
  for (const [k, v] of from.tuples) to.tuples.set(k, v)
  for (const [k, v] of from.got) to.got.set(k, v)
  for (const k of from.proved) to.proved.add(k)
  for (const [k, v] of from.retired) if (!to.retired.has(k)) to.retired.set(k, v)
}

/** The secret of a tuple stops proving anything new: its key was changed or
 *  given up. What it proved before stands; the fact names the proofs held
 *  then, so every device that learns of it draws the same line. */
export function retire (dev: Device, id: string): void { if (!dev.retired.has(id)) dev.retired.set(id, [...dev.got.keys()]) }

/** What a device shows: its tuples grouped into relationships. Two tuples
 *  are one relationship if the device holds a proof of the other end for
 *  the pair, under the secret of a tuple that was not retired when the
 *  proof was held. Computed from the facts, in no order. */
export function relationships (dev: Device): string[][] {
  const parent = new Map<string, string>([...dev.tuples.keys()].map((k) => [k, k]))
  const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r) as string; return r }
  for (const p of dev.got.values()) {
    const on = dev.tuples.get(p.on)
    if (!on || p.from === on.side) continue                                   // not for this end, or its own proof turned back
    const tags = new Set(p.tags)
    for (const x of dev.tuples.values()) {
      if (x.id === on.id) continue
      const before = dev.retired.get(x.id)
      if (before && !before.includes(p.id)) continue                           // a proof under a secret that was given up before it came
      if (tags.has(tag(x, on.id, p.from))) parent.set(find(x.id), find(on.id))
    }
  }
  const groups = new Map<string, string[]>()
  for (const k of dev.tuples.keys()) groups.set(find(k), [...(groups.get(find(k)) ?? []), k])
  return [...groups.values()].map((g) => g.sort()).sort((p, q) => (p[0] as string < (q[0] as string) ? -1 : 1))
}
export const contacts = (dev: Device): number => relationships(dev).length
/** How many tags of all proofs a device holds it can read. */
export function readable (dev: Device): number {
  let n = 0
  for (const p of dev.got.values()) { const on = dev.tuples.get(p.on); if (on) for (const x of dev.tuples.values()) if (x.id !== on.id && p.tags.includes(tag(x, on.id, p.from))) n++ }
  return n
}
