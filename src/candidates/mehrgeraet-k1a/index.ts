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
// mediator may name split by key number. Decisions (consent, decline) are
// allowed on every device; step 3 folds them by the model's rules (one
// effect per decision, a submitted own card decides consent against
// decline, the smaller of two hand-overs wins; model.ts `resolveDecision`),
// and the device withdraws its own card when the fold decided against it
// and the card never reached the carrier (holder.ts). The number
// of devices is fixed at the first enrollment (rights are never
// redistributed in step 1); a restore gives a fresh random incarnation; the
// candidate's volatile state is part of the device's checkpoint. Step 2:
// since the devices learn each other's tuples, a device keeps every probe
// it received with the entries that hit nothing and evaluates it again
// when a folded batch adds own tuples (`reevaluateProbes`); a hit owes the
// own mapping, the union itself still comes only from a verified
// counterpart mapping (6975.1) and travels as a journal operation.

import { randomBytes } from 'node:crypto'
import { EnrolmentRefused, seedScheme, type CandidateDevice, type HolderDevice, type Intent, type MultiDeviceCandidate, type Transaction } from '../../lab/mehrgeraet/holder'
import * as M from '../../lab/mehrgeraet/model'

const enc = new TextEncoder()
const dec = new TextDecoder()

interface Batch {
  writer: string
  n: number
  /** Batch keys (`writer#n`) of the last batch seen from every writer, including this device's own; every one must be known before this batch (step 1c). */
  deps: string[]
  ops: M.Op[]
  intents: Array<Omit<Intent, 'bytes'> & { bytes: string }>
}

interface Persisted {
  index: number
  slots: number
  inc: string
  batches: Batch[]
  out: Batch[]
}

export interface K1aOptions {
  /** Acceptance budget per mediator relationship for the whole person (8510); split evenly across devices. */
  budget?: number
  /** Devices per person, fixed (B4): rights are split by this number from the first device on; enrollment beyond it is refused. */
  devices?: number
}

const fresh = () => randomBytes(4).toString('hex')

export class K1aDevice implements CandidateDevice {
  readonly keys
  /** Position among the person's devices (0 = first) and how many devices share the rights, fixed at enrollment. */
  index: number
  slots: number
  /** Inkarnation: frische Zufallskennung je Instanz und je Restore (B2), nie aus dem Backup gezählt. */
  private inc = fresh()
  private batches: Batch[] = []
  private out: Batch[] = []
  private n = 0
  /** Step 2: devices learn their siblings' tuples through the journal, so the holder keeps received probes and evaluates them again when the own tuple set grows. */
  readonly reevaluateProbes = true
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
  /** Own acceptance ops across incarnations (the journal is the source of what this device consumed), unconfirmed and inside the 8510 window of `now` (S1). */
  private ownAccepted(rel: string, state: M.HolderState, now: string): number {
    const r = M.findRel(state, rel)
    if (!r) return 0
    const own = new Set<string>()
    for (const b of this.batches) if (b.writer.startsWith(`${this.name}@`)) for (const op of b.ops) if (op.kind === 'ticket-accept') own.add(op.act.id)
    const since = Date.parse(now) - M.PARAM.budgetWindowMs
    return r.accepted.filter((e) => own.has(e.act) && !r.confirmed.includes(e.act) && Date.parse(e.at) > since).length
  }
  /** Ein fremder Vorrats-Schlüssel gehört dem Gerät, dessen Platz seine Nummer trifft (8445: n mod Geräte); so wechseln sich die Geräte ab. */
  mayName(anchor: string, rel: string, state: M.HolderState): boolean {
    const r = M.findRel(state, rel)
    const k = r?.view?.keys.find((x) => x.anchor === anchor)
    if (!k) return false
    return k.n % this.slots === this.index
  }
  authorize(op: M.Op, state: M.HolderState): boolean {
    if (op.kind === 'ticket-accept') return this.ownAccepted(op.act.mediator, state, op.at) < this.share
    if (op.kind === 'introduce') return this.mayName(op.act.a.key, op.act.a.rel, state) && this.mayName(op.act.b.key, op.act.b.rel, state)
    return true
  }
  /** The last batch seen from every writer. */
  heads(): Record<string, number> {
    const h: Record<string, number> = {}
    for (const b of this.batches) if ((h[b.writer] ?? 0) < b.n) h[b.writer] = b.n
    return h
  }
  /** What a device with these heads has not seen yet, oldest first (the sync answer). */
  batchesAfter(heads: Record<string, number>) {
    return this.batches.filter((b) => b.n > (heads[b.writer] ?? 0)).map((b) => ({ body: enc.encode(JSON.stringify(b)) }))
  }
  commit(tx: Transaction): void {
    const deps = Object.entries(this.heads()).map(([w, n]) => `${w}#${n}`)
    const b: Batch = { writer: this.writer, n: ++this.n, deps, ops: tx.ops, intents: tx.intents.map((i) => ({ ...i, bytes: Buffer.from(i.bytes).toString('base64') })) }
    this.batches.push(b)
    this.out.push(b)
  }
  takeOwnFrames() {
    return this.out.splice(0).map((b) => ({ body: enc.encode(JSON.stringify(b)) }))
  }
  receiveOwnFrame(body: Uint8Array): Transaction {
    const b = JSON.parse(dec.decode(body)) as Batch
    const known = this.batches.find((x) => x.writer === b.writer && x.n === b.n)
    if (known) {
      if (JSON.stringify(known.ops) === JSON.stringify(b.ops) && JSON.stringify(known.intents) === JSON.stringify(b.intents) && JSON.stringify(known.deps) === JSON.stringify(b.deps)) return { ops: [], intents: [] } // schon bekannt: nichts Neues (Inhalt samt Abhängigkeiten, Review 9)
      // Gleicher Schlüssel, anderer Inhalt: zwei Inkarnationen mit derselben Kennung (B2); sichtbar machen, nicht still verwerfen.
      return { ops: [{ id: { writer: `${b.writer}#conflict`, n: b.n }, at: b.ops[0]?.at ?? new Date(0).toISOString(), kind: 'finding', text: `Journal-Konflikt: Batch ${b.writer}#${b.n} zweimal mit anderem Inhalt` }], intents: [] }
    }
    // Vorgänger: jeder Kopf, den der Schreiber beim Commit kannte, muss hier bekannt sein, sonst zurückstellen (und nachholen lassen).
    const knownKeys = new Set(this.batches.map((x) => `${x.writer}#${x.n}`))
    const missing = b.deps.find((d) => !knownKeys.has(d))
    if (missing) throw new M.Missing('batch', missing, this.person)
    return { ops: b.ops, intents: b.intents.map((i) => ({ ...i, bytes: new Uint8Array(Buffer.from(i.bytes, 'base64')) })) }
  }
  /** Das Gerät hat einen fremden Batch angewandt: ab jetzt bekannt (für Dedupe und Vorgänger). Vom Holder nach dem Gelingen gerufen. */
  applied(body: Uint8Array): void {
    const b = JSON.parse(dec.decode(body)) as Batch
    if (!this.batches.some((x) => x.writer === b.writer && x.n === b.n)) this.batches.push(b)
  }
  /** Flüchtiger Stand für die Rücknahme eines Schritts (B1): Journal, Ausgangsqueue, Zähler; die Inkarnation bleibt. */
  snapshot(): unknown {
    return { batches: structuredClone(this.batches), out: structuredClone(this.out), n: this.n }
  }
  rollback(s: unknown): void {
    const d = s as { batches: Batch[]; out: Batch[]; n: number }
    this.batches = d.batches
    this.out = d.out
    this.n = d.n
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
    this.inc = fresh() // neue Inkarnation (Befund 5), unabhängig vom Backup (B2)
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
  const slots = opts.devices ?? 2
  const seeds = new Map<string, Uint8Array>()
  const devices = new Map<string, K1aDevice[]>() // person → Geräte in Enrollment-Reihenfolge
  return {
    id: 'k1a-static',
    title: 'K1a: one seed, operation journal, static rights per device',
    capabilities: new Set(['journal', 'rights']),
    async first(person, name, seed) {
      seeds.set(person, seed)
      const d = new K1aDevice(person, name, seed, 0, slots, budget)
      devices.set(person, [d]) // eine neue Welt dieser Person: die Liste beginnt mit diesem Gerät
      return d
    },
    async instance(person, name, seed) {
      // Kein Gerät der Person (Dieb aus einem Abbild, X9): unregistriert; Platz und Plätze kommen aus dem Abbild beim `reload`.
      return new K1aDevice(person, name, seed, 0, slots, budget)
    },
    async enrol(from: HolderDevice, name) {
      const list = devices.get(from.person) ?? []
      // Feste Gerätezahl (B4): die Plätze stehen von Anfang an fest, nichts wird umverteilt; darüber hinaus wird verweigert (versionierte Rechte = K1b).
      if (list.length >= slots) throw new EnrolmentRefused(`K1a: Gerätezahl fest auf ${slots}; Enrollment von ${name} verweigert`)
      const d = new K1aDevice(from.person, name, seeds.get(from.person)!, list.length, slots, budget)
      d.adopt((from.cand as K1aDevice).journal())
      list.push(d)
      devices.set(from.person, list)
      // Zustand, Journal, Absichten und behaltene Proben wandern mit (das Abbild des Geräts): das neue Gerät kennt jede
      // offene Produktion, produziert nichts neu und kann die Proben neu auswerten, auch wenn `from` danach fehlt (Review 16 S2).
      const probes = [...from.keptProbes()].map(([id, e]): [string, string[]] => [id, [...e]])
      return { cand: d, state: structuredClone(from.state), intents: [...from.intents.values()], probes }
    },
    release(person, name) {
      const list = devices.get(person)
      if (list) devices.set(person, list.filter((d) => d.name !== name))
    },
  }
}
