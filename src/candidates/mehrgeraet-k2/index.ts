// K2: device keys (plan E15, section 6o.4). Step 1 (assumptions 6o.5 no. 1–5 under Anton's go of 18.10.2026): every
// device has its own secret (random, never derived from a seed shared by the person); every key of the device (pair
// anchors, self key, stock keys, card keys, the journal signing key) derives from that secret per context. The person's
// seed is not on any device. Step 2 (Anton's decisions of 19.10.2026, plan 6r): counterparts know a person's device set
// per relationship only from received proofs (`device-set@1`); the bench list stays for the person's own devices only
// (the journal's writer check and the siblings' set, until step 3); E2 (iv) one card per act from the device that
// allocated the named stock key. Stock keys per device (strict, Anton 20.10.): a stock key's private part lives only on the
// allocating device; only that device opens the ticket (sealed to the stock key), receives the counter card and produces
// the card. The shared variant of step 2 (#74) is removed; its measurements stay in the NOTES as a closed comparison.
//
// Step 2a (plan 6t): the mediator is a single-writer fixture in the matrix (one device, `bench.singleDevice`). Step 2b.1
// (core draft 4, §2–§4): A assigns every stock key to one M device (`for`) and lists it in `stock-revision@2` with a proof
// of possession; M names only keys assigned to it (the `for` filter of `usableView`); A supplies only from its free rights
// (balance per device) and checks acceptance per device (8640.13). M's issuance automaton is step 2b.2; until then the
// matrix keeps the fixture and the counter-run with two M devices (`singleDevice: []`) shows the split.
//
// What step 2 adds to the candidate: keys a sibling assigned from this device's pool (`pool/<i>`, `pool-use` ops in the
// journal) are this device's keys for that relationship's context; the enrolment ceremony carries the new device's keys
// for every existing context and its pool (QR stand-in, measured) and the old device admits it in every set where it is
// a member.

import { createHmac, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import { edFromSeed, xFromSeed, anchorOfEd, mkOfX } from '@real-life/trust-protocol'
import { derive, EnrolmentRefused, TYPES, UnknownWriter, type CandidateDevice, type EnrolOptions, type HolderDevice, type KeyScheme, type Keys, type MultiDeviceCandidate } from '../../lab/mehrgeraet/holder'
import * as M from '../../lab/mehrgeraet/model'
import { batchProblem, K1aDevice, MalformedBatch, type Batch } from '../mehrgeraet-k1a'

const enc = new TextEncoder()
const dec = new TextDecoder()

export interface K2Options {
  /** Acceptance budget per mediator relationship for the whole person (8510); split evenly across devices (MV-9, as K1a). */
  budget?: number
  /** Devices per person, fixed as in K1a (rights are static, K1b is not in K2's scope: assumption 6o.5 no. 5). */
  devices?: number
  /**
   * Counter-run "carrier only" (plan 6o.3): `false` = a revocation unregisters the device at the carrier and drops it from
   * the siblings' list, but sends no revocation entries to the counterparts (they keep sealing to the revoked device).
   */
  counterpartRevocation?: boolean
  /**
   * Step 2a (plan 6t): persons that run as a single-writer fixture (one device; the bench does not enrol a second one).
   * Default `['M']`: M's issuance automaton is step 2b.2. `[]` = counter-run with two M devices; since step 2b.1 A assigns
   * each stock key to one of them (X1, X13, X14 hold; in 2a without the split they failed: two acts on one key).
   */
  singleDevice?: string[]
  /** Counter-run of E2 (iv): `false` = every consenting device produces a card (step 1 behaviour). Default on. */
  producerRule?: boolean
  /** X23: lifetime of new stock keys (default 8465, 180 days). */
  stockLifetimeMs?: number
  /**
   * Step 2b.2 (core draft 4 §5, E4): the K2 capability of the issuance automaton: two facts per side with `ticket-ack@1`,
   * resumption as due work, the act-end stop at 8110.5 in three places, `TB` in release and resumption, 8232.1 for
   * tickets, the restart from the last commit. Default on for K2; `false` = the 2b.1 path (counter-run). K0/K1a never.
   */
  automaton?: boolean
}

/** Keys of one device for every context, derived from the device secret (step 1); the self key and the journal key come from here. */
export function deviceScheme(secret: Uint8Array): KeyScheme {
  const cache = new Map<string, Promise<Keys>>()
  return {
    pair(ctx) {
      let p = cache.get(ctx)
      if (!p) {
        p = keysOf(derive(secret, `ed/${ctx}`), derive(secret, `x/${ctx}`))
        cache.set(ctx, p)
      }
      return p
    },
  }
}
async function keysOf(edSeed: Uint8Array, xSeed: Uint8Array): Promise<Keys> {
  const ed = await edFromSeed(edSeed)
  const x = await xFromSeed(xSeed)
  return { ed, x, anchor: anchorOfEd(ed.pubRaw), rkid: mkOfX(x.pubRaw) }
}

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
/** The journal signing key of a device (Ed25519 from the device secret, node:crypto: synchronous inside `commit`). */
function journalKey(secret: Uint8Array): { priv: KeyObject; pub: KeyObject; raw: string } {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(derive(secret, 'journal-sign'))]), format: 'der', type: 'pkcs8' })
  const pub = createPublicKey(priv)
  return { priv, pub, raw: pub.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') }
}
interface SignedBatch extends Batch {
  /** Ed25519 signature of the producing device over the canonical batch (base64). */
  sig: string
}
/** What the device signs: the batch without its signature, canonical (sorted keys) after a JSON round trip. */
const signedBytes = (b: Omit<SignedBatch, 'sig'>) => Buffer.from(M.canonical(JSON.parse(JSON.stringify(b))))

interface Member {
  name: string
  scheme: KeyScheme
  journal: ReturnType<typeof journalKey>
}

/**
 * The bench-side list of a person's OWN devices (step 1; in step 2 only the siblings read it: the journal's writer check,
 * the self addresses and the sibling names; counterparts never do, they learn device sets from `device-set@1`). Per
 * person: every device ever enrolled and the current set. Step 3 replaces it with a journalized revocation.
 */
export class DeviceDirectory {
  readonly persons = new Map<string, { members: Map<string, Member>; set: string[] }>()
  /** A fresh world for this person (the candidate object serves several worlds in turn). */
  reset(person: string) {
    this.persons.set(person, { members: new Map(), set: [] })
  }
  member(name: string, secret: Uint8Array): Member {
    return { name, scheme: deviceScheme(secret), journal: journalKey(secret) }
  }
  add(person: string, m: Member) {
    const p = this.persons.get(person)!
    p.members.set(m.name, m)
    if (!p.set.includes(m.name)) p.set.push(m.name)
  }
  remove(person: string, name: string) {
    const p = this.persons.get(person)
    if (p) p.set = p.set.filter((n) => n !== name)
  }
  names(person: string): string[] {
    return [...(this.persons.get(person)?.set ?? [])]
  }
  async selfKeys(person: string): Promise<Array<{ device: string; anchor: string; rkid: string }>> {
    const p = this.persons.get(person)
    if (!p) return []
    const out = []
    for (const n of p.set) {
      const k = await p.members.get(n)!.scheme.pair(`self/${person}`)
      out.push({ device: n, anchor: k.anchor, rkid: k.rkid })
    }
    return out
  }
  /** The journal signing key of a device of the current set; undefined for a device outside it (revoked, never enrolled). */
  journalPub(person: string, device: string): KeyObject | undefined {
    const p = this.persons.get(person)
    return p?.set.includes(device) ? p.members.get(device)?.journal.pub : undefined
  }
  inSet(person: string, device: string): boolean {
    return this.persons.get(person)?.set.includes(device) ?? false
  }
}

/**
 * Step 2b.2 (draft 2 §2.3, MV-24, MV-30): the composition of an issuance batch, checked by the parser before the fold. A
 * batch with an `introduce` holds exactly one, and exactly two ticket intents of that act, one per side; a ticket intent
 * outside an issuance batch, or of another act, is a form error. `null` = fine.
 */
export function issuanceProblem(b: { writer?: string; ops: M.Op[]; intents: Array<{ kind: string; act?: string; side?: string; device?: string; address?: string }> }): string | null {
  const intro = b.ops.filter((op) => op.kind === 'introduce')
  const tickets = b.intents.filter((i) => i.kind === TYPES.ticket)
  if (!intro.length) return tickets.length ? 'batch.intents(ticket without introduce)' : null
  if (intro.length > 1) return 'batch.ops(more than one introduce)'
  const act = (intro[0] as M.Op & { kind: 'introduce' }).act.id
  if (tickets.length !== 2) return `batch.intents(${tickets.length} tickets, MV-30 wants 2)`
  if (tickets.some((t) => t.act !== act)) return 'batch.intents(ticket of another act)'
  if (new Set(tickets.map((t) => t.side)).size !== 2 || tickets.some((t) => t.side !== 'a' && t.side !== 'b')) return 'batch.intents(ticket sides)'
  // Opus-Review 54 S9: the issuing device is the batch writer, each ticket goes to the key agreement of the key it names.
  const issuer = b.writer?.split('@')[0]
  if (issuer !== undefined && tickets.some((t) => t.device !== issuer)) return 'batch.intents(ticket device is not the writer)'
  const named = (intro[0] as M.Op & { kind: 'introduce' }).act
  // Opus-Review 55 S5 (a), CodeRabbit (missing `by`): under the automaton `by` (who may write `ticket-ack@1`) is required
  // and is the writer of the issuance batch; a batch without it would leave the act open to acknowledgements of any writer.
  if (issuer !== undefined && named.by !== issuer) return named.by === undefined ? 'batch.ops(introduce.act.by missing)' : 'batch.ops(introduce.act.by is not the writer)'
  if (tickets.some((t) => t.address !== named[t.side as 'a' | 'b'].keyAgreement)) return 'batch.intents(ticket address is not the named key)'
  return null
}
export class K2Device extends K1aDevice {
  /** The device secret: the root of every key of this device; part of the image (`persist`), never shared. */
  private secret: Uint8Array
  private member: Member
  readonly signerWriters = true
  readonly deviceSets = true
  /** Step 2: contexts of relationships a sibling opened, mapped to the key of this device's pool it assigned (`pool-use`). */
  private assigned = new Map<string, number>()
  private cache = new Map<string, Promise<Keys>>()
  /** K2 step 2b.1: the anchor of this device per context once derived (synchronous for `authorize`, the `for` filter). */
  private anchors = new Map<string, string>()
  /** The device whose image this candidate carries (`name` for a device of the set; a thief keeps the stolen device's name). */
  owner: string
  constructor(
    person: string,
    name: string,
    secret: Uint8Array,
    index: number,
    slots: number,
    budget: number,
    private readonly dir: DeviceDirectory,
    readonly producerRule = true,
    readonly revocationToCounterparts = true,
    readonly stockLifetimeMs?: number,
    readonly issuanceAutomaton = true,
  ) {
    super(person, name, new Uint8Array(32), index, slots, budget, false, false) // no writer tags, no number classes
    this.keepOnRestart = issuanceAutomaton
    this.owner = name
    this.secret = secret
    this.member = dir.member(name, secret)
    this.keys = { pair: (ctx) => this.pairFor(ctx) }
  }
  get public(): Member {
    return this.member
  }
  /**
   * The device's key for a context: a key from its pool if a sibling assigned it to this context (step 2), otherwise its
   * own derivation. Cached per source, so a later assignment is never shadowed by an earlier own derivation.
   */
  private pairFor(ctx: string): Promise<Keys> {
    const i = this.assigned.get(ctx)
    const src = i !== undefined ? `pool/${i}` : ctx
    let p = this.cache.get(src)
    if (!p) {
      p = keysOf(derive(this.secret, `ed/${src}`), derive(this.secret, `x/${src}`))
      this.cache.set(src, p)
    }
    return p.then((k) => (this.anchors.set(ctx, k.anchor), k))
  }
  /** Assignments from a batch (verified first): monotone facts, safe to learn before the fold. */
  private learn(b: SignedBatch): void {
    for (const op of b.ops) if (op.kind === 'pool-use' && op.device === this.owner) this.assigned.set(op.ctx, op.i)
  }
  /**
   * Step 2b.1 (MV-32): the right to name a stock key per M device comes from A (`for`, filtered in M's view), not from a
   * computation at M; every key of the filtered view may be named. K1a keeps `n mod devices` (its cells stay as on main).
   */
  override mayName(): boolean {
    return true
  }
  /** Step 2b.1: A assigns every stock key to one M device and lists it in `stock-revision@2` (core draft 4 §2, §3). */
  readonly allocationByA = true
  /** Step 2b.1: the static share of the acceptance budget (MV-9). */
  get acceptanceShare(): number {
    return this.share
  }
  /** Step 2b.1: `belegt` (core draft 4 §2.1). */
  occupied(rel: string, state: M.HolderState, now: string): number {
    return this.ownAccepted(rel, state, now)
  }
  /** Step 2b.1: `inc` of `stock-revision@2`, HMAC of the journal incarnation over the relationship (draft 2 §3.1), 16 characters. */
  incTag(relationship: string): string {
    return createHmac('sha256', derive(this.secret, 'inc-tag')).update(`${relationship}|${this.inc}`).digest().subarray(0, 12).toString('base64url')
  }
  async selfPeers() {
    return (await this.dir.selfKeys(this.person)).filter((k) => k.device !== this.name).map(({ anchor, rkid }) => ({ anchor, rkid }))
  }
  async selfDevice(anchor: string): Promise<string | null> {
    return (await this.dir.selfKeys(this.person)).find((k) => k.anchor === anchor)?.device ?? null
  }
  siblingNames(): string[] {
    return this.dir.names(this.person).filter((n) => n !== this.owner)
  }
  /** Every device numbers its own stock under its own nonce (8430, 8445 per device), stable across a restore. */
  stockNonce(relationship: string): string {
    return Buffer.from(derive(this.secret, `nonce/${relationship}`)).toString('base64')
  }
  /** Step 2: only the allocating device holds the private part of a stock key (strict). */
  holdsStock(k: M.StockKey): boolean {
    return k.by === this.owner
  }
  /**
   * MV-9 under device keys (step 2): the static quota per device travels with the keys the device lists. An acceptance
   * counts for the device that allocated the named stock key (only it opens the ticket). Step 2b.1: this is `belegt` of the
   * balance (core draft 4 §2.1): the device lists only from `frei_zuteilbar = share − belegt − reserviert` and accepts only
   * while `belegt < share` (8640.13 per device). The person's hard limit stays at the side (8510, 8640.10).
   */
  protected override ownAccepted(rel: string, state: M.HolderState, now: string): number {
    const r = M.findRel(state, rel)
    if (!r) return 0
    const since = Date.parse(now) - M.PARAM.budgetWindowMs
    const mine = (act: string) => {
      const a = state.acts.find((x) => x.id === act)
      return !!a && r.stock.some((k) => k.anchor === a.own && k.by === this.owner)
    }
    return r.accepted.filter((e) => mine(e.act) && !r.confirmed.includes(e.act) && Date.parse(e.at) > since).length
  }
  /**
   * Step 2b.1: the acceptance check per device is the holder's 8640.13 branch before the op (key consumed, no act, no
   * receipt, no budget load; core draft 4 §2.1), never a `Blocked` here. An introduction names only keys A assigned to this
   * device (`for` = its anchor in that relationship) from the one computation of M's view (MV-32, `usableView`).
   */
  override authorize(op: M.Op, state: M.HolderState): boolean {
    if (op.kind === 'ticket-accept') return true
    // Opus-Review 54 B3 (E1 of review 1): under the automaton the right is checked on the same conditions as the choice, in
    // the same state (usable by 8470, not consumed); the 2b.1 path keeps `listed`.
    if (op.kind === 'introduce') return [op.act.a, op.act.b].every((x) => M.usableView(state, x.rel, op.at, this.mineIn(state, x.rel))[this.issuanceAutomaton ? 'unconsumed' : 'listed'].some((k) => k.anchor === x.key))
    return super.authorize(op, state)
  }
  /** Step 2b.1: this device's anchors in a relationship (one per tuple context it derived). */
  private mineIn(state: M.HolderState, rel: string): Set<string> {
    const r = M.findRel(state, rel)
    return new Set((r?.tuples ?? []).map((t) => this.anchors.get(t.ownKey)).filter((a): a is string => !!a))
  }
  poolKey(i: number): Promise<Keys> {
    return this.pairFor(`pool/${i}`)
  }
  override commit(tx: Parameters<K1aDevice['commit']>[0]): void {
    super.commit(tx)
    const b = this.batches[this.batches.length - 1] as SignedBatch
    b.sig = sign(null, signedBytes(b), this.member.journal.priv).toString('base64')
    this.learn(b)
  }
  /**
   * The fold's entry for a journal batch (pure apart from monotone facts): signature first, against the writer's device key
   * on the own list; a writer outside the set or a signature that is not its writer's is `UnknownWriter` (holder: finding
   * `journal:unknown-writer`, never state, no receipt). Then the assignments of the batch are learnt and K1a's shape and
   * order checks run on the batch without `sig`.
   */
  /**
   * The writer binding of a signed journal batch (loop review on 60a6674): every op id, every intent (`writer`, `device`),
   * every allocated stock key (`by`) and the issuer of an act (`by`) name the authenticated signer of the batch. One place,
   * the parser, before anything is learnt or folded. `null` = bound.
   */
  writerProblem(b: { writer: string; ops: M.Op[]; intents: Array<{ writer?: string; device?: string }> }, state?: M.HolderState): string | null {
    const device = b.writer.split('@')[0]!
    // Opus-Review 57 S1: an own `revision` op names its writer as the signer id of the writing device's key in that
    // relationship; the own device sets (`local`: member anchor → device) say whose it is. A writer that belongs to another
    // device of the person is a claim; an unknown one gets no verdict here (the set may not be known yet).
    const ownerOf = (writer: string): string | undefined => {
      for (const set of Object.values(state?.sets ?? {})) for (const [anchor, dev] of Object.entries(set.local ?? {})) if (M.signerId(anchor) === writer) return dev
      return undefined
    }
    for (const op of b.ops) {
      if (op.id.writer !== b.writer) return `op ${op.kind} claims writer ${op.id.writer}`
      if (op.kind === 'revision' && op.writer !== undefined) {
        const owner = ownerOf(op.writer)
        if (owner !== undefined && owner !== device) return `revision claims the writer of ${owner}`
      }
      if (op.kind === 'allocate' && op.keys.some((k) => k.by !== undefined && k.by !== device)) return 'allocate claims another allocating device'
      if (op.kind === 'introduce' && op.act.by !== undefined && op.act.by !== device) return 'introduce claims another issuer'
    }
    for (const i of b.intents) if ((i.writer !== undefined && i.writer !== b.writer) || (i.device !== undefined && i.device !== device)) return `intent claims writer ${i.writer} on ${i.device}`
    return null
  }
  override receiveOwnFrame(body: Uint8Array, state?: M.HolderState) {
    const raw: unknown = JSON.parse(dec.decode(body))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new MalformedBatch('batch')
    const { sig, ...rest } = raw as SignedBatch
    if (!M.isBase64(sig)) throw new MalformedBatch('batch.sig')
    const problem = batchProblem(rest)
    if (problem) throw new MalformedBatch(problem)
    const device = rest.writer.split('@')[0]!
    const pub = this.dir.journalPub(this.person, device)
    if (!pub) throw new UnknownWriter(`writer ${rest.writer} is not in the device set of ${this.person}`)
    if (!verify(null, signedBytes(rest), pub, Buffer.from(sig, 'base64'))) throw new UnknownWriter(`batch ${rest.writer}#${rest.n} not signed by ${device}`)
    // Loop review on 60a6674 (writer binding, MV-24): the signature authenticates `rest.writer`; no field inside the batch
    // may name another writer. Otherwise the whole batch is a form error, nothing of it is folded.
    const mismatch = this.writerProblem(rest, state)
    if (mismatch) throw new MalformedBatch(`batch:writer-mismatch: ${mismatch}`)
    if (this.issuanceAutomaton) {
      const bad = issuanceProblem(rest)
      if (bad) throw new MalformedBatch(bad)
    }
    this.learn({ ...rest, sig })
    return super.receiveOwnFrame(enc.encode(JSON.stringify(rest)))
  }
  override adopt(batches: Batch[]) {
    super.adopt(batches)
    for (const b of batches) this.learn(b as SignedBatch)
  }
  override persist() {
    return { ...super.persist(), secret: Buffer.from(this.secret).toString('base64'), owner: this.owner }
  }
  override restore(data: unknown, opts?: { fresh?: boolean }): void {
    super.restore(data, opts)
    const d = data as { secret?: string; owner?: string } | null
    if (!d?.secret) return
    this.secret = new Uint8Array(Buffer.from(d.secret, 'base64'))
    this.owner = d.owner ?? this.name
    this.member = this.dir.member(this.name, this.secret)
    this.cache = new Map()
    this.anchors = new Map()
    this.assigned = new Map()
    for (const b of this.batches) this.learn(b as SignedBatch)
  }
}

export type K2Candidate = MultiDeviceCandidate & {
  readonly directory: DeviceDirectory
  readonly ceremonies: Array<{ person: string; device: string; bytesNewToOld: number; bytesOldToNew: number; contexts: number }>
}

export function k2(opts: K2Options = {}): K2Candidate {
  const budget = opts.budget ?? M.PARAM.budget
  const slots = opts.devices ?? 2
  const counterparts = opts.counterpartRevocation ?? true
  const single = opts.singleDevice ?? ['M']
  const producer = opts.producerRule ?? true
  const dir = new DeviceDirectory()
  const devices = new Map<string, K2Device[]>()
  const ceremonies: K2Candidate['ceremonies'] = []
  const secret = () => new Uint8Array(randomBytes(32))
  const automaton = opts.automaton ?? true
  const make = (person: string, name: string, index: number) => new K2Device(person, name, secret(), index, slots, budget, dir, producer, counterparts, opts.stockLifetimeMs, automaton)
  const id = single.includes('M') ? 'k2-device-keys' : 'k2-device-keys-distributed-m'
  const size = (x: unknown) => Buffer.byteLength(JSON.stringify(x), 'utf8')
  return {
    id,
    title: 'K2-strict: device keys, device-set@1, stock keys per device assigned per M device (step 2b.1); M as single-writer fixture in the matrix',
    capabilities: new Set(['journal', 'rights', 'device-keys', 'device-sets'] as const),
    // Step 2a (plan 6t): the bench gives these persons one device (single-writer fixture); distributed M is step 2b.
    bench: { singleDevice: single },
    directory: dir,
    ceremonies,
    async first(person, name) {
      dir.reset(person) // the seed of the person is ignored: no device holds it
      const d = make(person, name, 0)
      dir.add(person, d.public)
      devices.set(person, [d])
      return d
    },
    async instance(person, name) {
      // A thief from an image (X9): an independent instance outside the set; `reload` brings the stolen device's secret.
      return make(person, name, 0)
    },
    async enrol(from: HolderDevice, name, eo?: EnrolOptions) {
      const list = devices.get(from.person) ?? []
      if (list.length >= slots) throw new EnrolmentRefused(`K2: Gerätezahl fest auf ${slots}; Enrollment von ${name} verweigert`)
      if (eo?.fromLog) throw new EnrolmentRefused('K2: kein Enrollment aus der Ablage')
      const old = from.cand as K2Device
      const d = make(from.person, name, list.length)
      // QR between the two own devices (6o.5 no. 4, plan 6o.2): the new device shows its name, self and journal keys, its key
      // for every context of the person (one per own root: tuples and unconnected cards) and a pool for each sibling; the old
      // device answers with its own keys. Measured as bytes; the old device then admits the new one in every set where it is a
      // member and sends one revision per relationship (fan-out).
      const roots: Array<{ root: string; ctx: string }> = []
      for (const r of from.state.relationships) for (const t of r.tuples) roots.push({ root: t.own, ctx: t.ownKey })
      for (const a of from.state.acts) if (a.ownCard && a.ownCardKey && !a.opened) roots.push({ root: a.ownCard.anchor, ctx: a.ownCardKey })
      const entries: Array<{ root: string; anchor: string; keyAgreement: string }> = []
      for (const { root, ctx } of roots) {
        const k = await d.keys.pair(ctx)
        entries.push({ root, anchor: k.anchor, keyAgreement: k.rkid })
      }
      const pool: Array<{ i: number; for: string; anchor: string; keyAgreement: string }> = []
      let i = 0
      for (const sib of [from.name, ...old.siblingNames()]) {
        for (let j = 0; j < 4; j++, i++) {
          const k = await d.poolKey(i)
          pool.push({ i, for: sib, anchor: k.anchor, keyAgreement: k.rkid })
        }
      }
      const self = async (m: Member) => {
        const k = await m.scheme.pair(`self/${from.person}`)
        return { device: m.name, anchor: k.anchor, rkid: k.rkid, journal: m.journal.raw }
      }
      ceremonies.push({ person: from.person, device: name, bytesNewToOld: size({ ...(await self(d.public)), entries: entries.map(({ anchor, keyAgreement }) => ({ anchor, keyAgreement })), pool }), bytesOldToNew: size(await self(old.public)), contexts: entries.length })
      dir.add(from.person, d.public)
      await from.enrolMember(name, entries, pool)
      d.adopt(old.journal())
      for (const s of old.siblings()) d.meet(s)
      d.meet(from.name)
      old.meet(name)
      list.push(d)
      devices.set(from.person, list)
      const probes = [...from.keptProbes()].map(([id, e]): [string, string[]] => [id, [...e]])
      return { cand: d, state: M.cloneState(from.state), intents: [...from.intents.values()], probes }
    },
    async revoke(_from, device) {
      // The siblings' list (bench, until step 3); the counterparts learn it from the revocation entries (holder `revokeInSets`).
      for (const [person, list] of devices) if (list.some((d) => d.name === device)) dir.remove(person, device)
    },
    release(person, name) {
      dir.remove(person, name)
      const list = devices.get(person)
      if (list) devices.set(person, list.filter((d) => d.name !== name))
      for (const d of list ?? []) d.forget(name)
    },
  }
}
