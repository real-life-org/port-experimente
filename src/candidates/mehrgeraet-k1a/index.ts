// K1a: one seed, an operation journal, static rights (plan E15, section 3;
// gate review 6: what step 1 needs). Every device derives all keys from the
// same seed, like K0. Every committed step of a device travels as one
// journal batch to the person's own address: writer incarnation and
// counter as the batch key, the previous batch of the same device as the
// predecessor, the operations and the production intents of the step.
// A device applies a batch only after its predecessor (otherwise the frame
// is deferred and repeated by the sender), exactly once per batch, and
// never re-produces an intent of another device. Rights are assigned
// statically at enrollment to the writer that consumes them: acceptance
// budget split evenly across the devices of a person, the stock keys a
// mediator may name split by anchor hash. Decisions (consent, decline) are
// allowed on every device; a conflict stays visible in the fold.

import { seedScheme, type CandidateDevice, type HolderDevice, type Intent, type MultiDeviceCandidate, type Transaction } from '../../lab/mehrgeraet/holder'
import * as M from '../../lab/mehrgeraet/model'

const enc = new TextEncoder()
const dec = new TextDecoder()

interface Batch {
  writer: string
  n: number
  /** Operation ids of the previous batch of this device (any incarnation); every one must be applied before this batch. */
  deps: string[]
  ops: M.Op[]
  intents: Array<Omit<Intent, 'bytes'> & { bytes: string }>
}

interface Persisted {
  index: number
  slots: number
  inc: number
  batches: Batch[]
  out: Batch[]
}

export interface K1aOptions {
  /** Acceptance budget per mediator relationship for the whole person (8510); split evenly across devices. */
  budget?: number
}

export class K1aDevice implements CandidateDevice {
  readonly keys
  /** Position among the person's devices (0 = first) and how many devices share the rights, fixed at enrollment. */
  index: number
  slots: number
  private inc = 1
  private batches: Batch[] = []
  private out: Batch[] = []
  private n = 0
  constructor(
    readonly person: string,
    readonly name: string,
    seed: Uint8Array,
    index: number,
    slots: number,
    private readonly budget: number,
  ) {
    this.keys = seedScheme(seed)
    this.index = index
    this.slots = slots
  }
  get writer() {
    return `${this.name}@${this.inc}`
  }
  private get share() {
    return Math.floor(this.budget / this.slots)
  }
  /** Own acceptance ops across incarnations (the journal is the source of what this device consumed). */
  private ownAccepted(rel: string, state: M.HolderState): number {
    const r = M.findRel(state, rel)
    if (!r) return 0
    const own = new Set<string>()
    for (const b of this.batches) if (b.writer.startsWith(`${this.name}@`)) for (const op of b.ops) if (op.kind === 'ticket-accept') own.add(op.act.id)
    return r.accepted.filter((e) => own.has(e.act) && !r.confirmed.includes(e.act)).length
  }
  /** Ein fremder Vorrats-Schlüssel gehört dem Gerät, dessen Platz seine Nummer trifft (8445: n mod Geräte); so wechseln sich die Geräte ab. */
  mayName(anchor: string, rel: string, state: M.HolderState): boolean {
    const r = M.findRel(state, rel)
    const k = r?.view?.keys.find((x) => x.anchor === anchor)
    if (!k) return false
    return k.n % this.slots === this.index
  }
  authorize(op: M.Op, state: M.HolderState): boolean {
    if (op.kind === 'ticket-accept') return this.ownAccepted(op.act.mediator, state) < this.share
    if (op.kind === 'introduce') return this.mayName(op.act.a.key, op.act.a.rel, state) && this.mayName(op.act.b.key, op.act.b.rel, state)
    return true
  }
  commit(tx: Transaction): void {
    const last = [...this.batches].reverse().find((b) => b.writer.startsWith(`${this.name}@`))
    const b: Batch = { writer: this.writer, n: ++this.n, deps: last ? last.ops.map((o) => M.opKey(o.id)) : [], ops: tx.ops, intents: tx.intents.map((i) => ({ ...i, bytes: Buffer.from(i.bytes).toString('base64') })) }
    this.batches.push(b)
    this.out.push(b)
  }
  takeOwnFrames() {
    return this.out.splice(0).map((b) => ({ body: enc.encode(JSON.stringify(b)) }))
  }
  receiveOwnFrame(body: Uint8Array): Transaction {
    const b = JSON.parse(dec.decode(body)) as Batch
    const key = `${b.writer}#${b.n}`
    if (this.batches.some((x) => `${x.writer}#${x.n}` === key)) return { ops: [], intents: [] } // schon bekannt: nichts Neues
    // Vorgänger: jede Operation des vorigen Batches dieses Geräts muss bekannt sein, sonst zurückstellen.
    const known = new Set(this.batches.flatMap((x) => x.ops.map((o) => M.opKey(o.id))))
    const missing = b.deps.find((d) => !known.has(d))
    if (missing) throw new M.Missing('batch', missing, this.person)
    return { ops: b.ops, intents: b.intents.map((i) => ({ ...i, bytes: new Uint8Array(Buffer.from(i.bytes, 'base64')) })) }
  }
  /** Das Gerät hat einen fremden Batch angewandt: ab jetzt bekannt (für Dedupe und Vorgänger). Vom Holder nach dem Gelingen gerufen. */
  applied(body: Uint8Array): void {
    const b = JSON.parse(dec.decode(body)) as Batch
    if (!this.batches.some((x) => x.writer === b.writer && x.n === b.n)) this.batches.push(b)
  }
  persist(): Persisted {
    return { index: this.index, slots: this.slots, inc: this.inc, batches: this.batches, out: this.out }
  }
  restore(data: unknown): void {
    const d = data as Persisted | null
    if (!d) return
    this.index = d.index
    this.slots = d.slots
    this.batches = d.batches
    this.out = d.out
    this.inc = d.inc + 1 // neue Inkarnation (Befund 5)
    this.n = 0
  }
  /** Journal für ein neues Gerät: alles, was dieses Gerät kennt. */
  journal(): Batch[] {
    return structuredClone(this.batches)
  }
  adopt(batches: Batch[]) {
    this.batches = batches
  }
}

export function k1a(opts: K1aOptions = {}): MultiDeviceCandidate {
  const budget = opts.budget ?? M.PARAM.budget
  const seeds = new Map<string, Uint8Array>()
  const devices = new Map<string, K1aDevice[]>() // person → Geräte in Enrollment-Reihenfolge
  return {
    id: 'k1a-static',
    title: 'K1a: one seed, operation journal, static rights per device',
    capabilities: new Set(['journal', 'rights']),
    async first(person, name, seed) {
      seeds.set(person, seed)
      const d = new K1aDevice(person, name, seed, 0, 1, budget)
      devices.set(person, [d])
      return d
    },
    async enrol(from: HolderDevice, name) {
      const list = devices.get(from.person) ?? []
      const slots = list.length + 1
      // Statisch beim Enrollment: alle bisherigen Geräte teilen neu; das neue Gerät erhält den letzten Platz, den Zustand und das Journal.
      for (const d of list) d.slots = slots
      const d = new K1aDevice(from.person, name, seeds.get(from.person)!, slots - 1, slots, budget)
      d.adopt((from.cand as K1aDevice).journal())
      list.push(d)
      devices.set(from.person, list)
      // Zustand, Journal und Absichten wandern mit: das neue Gerät kennt jede offene Produktion und produziert nichts neu.
      return { cand: d, state: structuredClone(from.state), intents: [...from.intents.values()] }
    },
  }
}
