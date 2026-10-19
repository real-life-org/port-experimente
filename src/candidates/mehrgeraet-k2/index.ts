// K2: device keys (plan E15, section 6o.4). Step 1 (assumptions 6o.5 no. 1–5 under Anton's go of 18.10.2026): every
// device has its own secret (random, never derived from a seed shared by the person); every key of the device (pair
// anchors, self key, stock keys, card keys, the journal signing key) derives from that secret per context. The person's
// seed is not on any device. Step 2 (Anton's decisions of 19.10.2026, plan 6r): counterparts know a person's device set
// per relationship only from received proofs (`device-set@1`); the bench list stays for the person's own devices only
// (the journal's writer check and the siblings' set, until step 3); E2 (iv) one card per act from the device that
// allocated the named stock key; two variants of the stock keys, measured side by side:
//
// - K2-strict (`k2-device-keys`): a stock key's private part lives only on the allocating device; only that device opens
//   the ticket (sealed to the stock key), receives the counter card and produces the card.
// - K2-shared (`k2-shared-stock`): the private part of every stock key travels to the siblings inside the sealed, signed
//   journal batch ("the key belongs to the set, production to the device"): every device opens the ticket, consent
//   anywhere, the allocating device produces the card. On revocation the siblings withdraw every key the revoked device
//   knew (empty revision, 8535) and refill.
//
// What step 2 adds to the candidate: keys a sibling assigned from this device's pool (`pool/<i>`, `pool-use` ops in the
// journal) are this device's keys for that relationship's context; the enrolment ceremony carries the new device's keys
// for every existing context and its pool (QR stand-in, measured) and the old device admits it in every set where it is
// a member; the shared variant attaches the stock key seeds to the batch that allocates them.

import { createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import { edFromSeed, xFromSeed, anchorOfEd, mkOfX } from '@real-life/trust-protocol'
import { derive, EnrolmentRefused, UnknownWriter, type CandidateDevice, type EnrolOptions, type HolderDevice, type KeyScheme, type Keys, type MultiDeviceCandidate } from '../../lab/mehrgeraet/holder'
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
   * Interim rule until step 5: keep K1a's split of the keys a mediator device may name (n mod devices, `mayName`). Default
   * on; off = counter-run, M names any key of the person's stock (X1, X13, X14 fail).
   */
  mediatorSplit?: boolean
  /** Step 2 (Anton 19.10.): where the private part of a stock key lives: the allocating device (`strict`, default) or the set (`shared`). */
  stock?: 'strict' | 'shared'
  /** Counter-run of E2 (iv): `false` = every consenting device produces a card (step 1 behaviour). Default on. */
  producerRule?: boolean
  /** X23: lifetime of new stock keys (default 8465, 180 days). */
  stockLifetimeMs?: number
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
  /** K2-shared: the seeds of the stock keys this batch allocates (the private part belongs to the set; sealed per sibling). */
  seeds?: Array<{ ctx: string; ed: string; x: string }>
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

export class K2Device extends K1aDevice {
  /** The device secret: the root of every key of this device; part of the image (`persist`), never shared. */
  private secret: Uint8Array
  private member: Member
  readonly signerWriters = true
  readonly deviceSets = true
  /** Step 2: contexts of relationships a sibling opened, mapped to the key of this device's pool it assigned (`pool-use`). */
  private assigned = new Map<string, number>()
  /** Step 2, K2-shared: stock key seeds of the set (from the signed, sealed journal), per context. */
  private seeds = new Map<string, { ed: string; x: string }>()
  private cache = new Map<string, Promise<Keys>>()
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
    private readonly nameSplit = true,
    readonly stockMode: 'strict' | 'shared' = 'strict',
    readonly producerRule = true,
    readonly revocationToCounterparts = true,
    readonly stockLifetimeMs?: number,
  ) {
    super(person, name, new Uint8Array(32), index, slots, budget, false, false) // no writer tags, no number classes
    this.owner = name
    this.secret = secret
    this.member = dir.member(name, secret)
    this.keys = { pair: (ctx) => this.pairFor(ctx) }
  }
  get public(): Member {
    return this.member
  }
  /**
   * The device's key for a context: a key from its pool if a sibling assigned it to this context (step 2), the set's key
   * for a shared stock key (K2-shared), otherwise its own derivation. Cached per source, so a later assignment is never
   * shadowed by an earlier own derivation.
   */
  private pairFor(ctx: string): Promise<Keys> {
    const i = this.assigned.get(ctx)
    const seed = this.seeds.get(ctx)
    const src = i !== undefined ? `pool/${i}` : seed ? `shared/${ctx}` : ctx
    let p = this.cache.get(src)
    if (!p) {
      p = seed && i === undefined ? keysOf(new Uint8Array(Buffer.from(seed.ed, 'base64')), new Uint8Array(Buffer.from(seed.x, 'base64'))) : keysOf(derive(this.secret, `ed/${src}`), derive(this.secret, `x/${src}`))
      this.cache.set(src, p)
    }
    return p
  }
  /** Assignments and shared seeds from a batch (verified first): monotone facts, safe to learn before the fold. */
  private learn(b: SignedBatch): void {
    for (const op of b.ops) if (op.kind === 'pool-use' && op.device === this.owner) this.assigned.set(op.ctx, op.i)
    if (this.stockMode === 'shared') for (const x of b.seeds ?? []) if (!this.seeds.has(x.ctx)) this.seeds.set(x.ctx, { ed: x.ed, x: x.x })
  }
  /**
   * Interim rule: K1a's `n mod devices` split until step 5; off (counter-run) M names any key of the person's stock.
   * Review 35 B6: the split reads the key's number from the writers' listings, not from the stored view. Whether the key
   * is in force is the selection's business (`unrevokedKeys`): a revoked signer's tombstone, folded before M knew the
   * revocation, is left out of the stored view but no longer counts for a key a remaining writer lists.
   */
  override mayName(anchor: string, rel: string, state: M.HolderState): boolean {
    if (!this.nameSplit) return true
    const v = M.findRel(state, rel)?.view
    const k = Object.values(v?.writers ?? {}).flatMap((x) => x.keys).find((x) => x.anchor === anchor) ?? v?.keys.find((x) => x.anchor === anchor)
    return !!k && k.n % this.slots === this.index
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
  /** Step 2: strict, only the allocating device holds the private part; shared, every device that has the seed from the journal. */
  holdsStock(k: M.StockKey): boolean {
    return k.by === this.owner || (this.stockMode === 'shared' && this.seeds.has(k.key))
  }
  /**
   * MV-9 under device keys (step 2): the static quota per device travels with the keys the device lists. An acceptance
   * counts for the device that allocated the named stock key, whichever device accepted the ticket (K2-shared: every
   * device opens it, two may accept the same ticket concurrently, the act counts once); a device lists at most as many own
   * keys as it has acceptances left (`quotaLeft`), so every key M can name can be accepted and no ticket waits for a quota.
   * The person's hard limit stays at the side (8510, `budgetExhausted` in 8640.10).
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
  /** Step 2: acceptance is not blocked per device: the key's allocator reserved it when it listed the key (`quotaLeft`). */
  override authorize(op: M.Op, state: M.HolderState): boolean {
    if (op.kind === 'ticket-accept') return true
    return super.authorize(op, state)
  }
  /** Step 2: how many acceptances this device has left in the relationship (MV-9); it lists at most that many own keys. */
  quotaLeft(rel: string, state: M.HolderState, now: string): number {
    return Math.max(0, this.share - this.ownAccepted(rel, state, now))
  }
  /** Step 2: each device keeps its own share of the stock at M (8485 split across the fixed device count). */
  stockShare() {
    return { below: Math.ceil(M.PARAM.refillBelow / this.slots), to: Math.ceil(M.PARAM.refillTo / this.slots) }
  }
  poolKey(i: number): Promise<Keys> {
    return this.pairFor(`pool/${i}`)
  }
  override commit(tx: Parameters<K1aDevice['commit']>[0]): void {
    super.commit(tx)
    const b = this.batches[this.batches.length - 1] as SignedBatch
    if (this.stockMode === 'shared') {
      const seeds: Array<{ ctx: string; ed: string; x: string }> = []
      for (const op of b.ops) if (op.kind === 'allocate') for (const k of op.keys) if (k.by === this.owner) seeds.push({ ctx: k.key, ed: Buffer.from(derive(this.secret, `ed/${k.key}`)).toString('base64'), x: Buffer.from(derive(this.secret, `x/${k.key}`)).toString('base64') })
      if (seeds.length) b.seeds = seeds
    }
    b.sig = sign(null, signedBytes(b), this.member.journal.priv).toString('base64')
    this.learn(b)
  }
  /**
   * The fold's entry for a journal batch (pure apart from monotone facts): signature first, against the writer's device key
   * on the own list; a writer outside the set or a signature that is not its writer's is `UnknownWriter` (holder: finding
   * `journal:unknown-writer`, never state, no receipt). Then the assignments and shared seeds of the batch are learnt and
   * K1a's shape and order checks run on the batch without `sig` and `seeds`.
   */
  override receiveOwnFrame(body: Uint8Array) {
    const raw: unknown = JSON.parse(dec.decode(body))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new MalformedBatch('batch')
    const { sig, seeds, ...rest } = raw as SignedBatch
    if (!M.isBase64(sig)) throw new MalformedBatch('batch.sig')
    if (seeds !== undefined && M.shapeProblem(seeds, SEEDS_SHAPE, 'batch.seeds')) throw new MalformedBatch('batch.seeds')
    const problem = batchProblem(rest)
    if (problem) throw new MalformedBatch(problem)
    const device = rest.writer.split('@')[0]!
    const pub = this.dir.journalPub(this.person, device)
    if (!pub) throw new UnknownWriter(`writer ${rest.writer} is not in the device set of ${this.person}`)
    if (!verify(null, signedBytes(seeds ? { ...rest, seeds } : rest), pub, Buffer.from(sig, 'base64'))) throw new UnknownWriter(`batch ${rest.writer}#${rest.n} not signed by ${device}`)
    this.learn({ ...rest, sig, ...(seeds ? { seeds } : {}) })
    return super.receiveOwnFrame(enc.encode(JSON.stringify(rest)))
  }
  override adopt(batches: Batch[]) {
    super.adopt(batches)
    for (const b of batches) this.learn(b as SignedBatch)
  }
  override persist() {
    return { ...super.persist(), secret: Buffer.from(this.secret).toString('base64'), owner: this.owner }
  }
  override restore(data: unknown): void {
    super.restore(data)
    const d = data as { secret?: string; owner?: string } | null
    if (!d?.secret) return
    this.secret = new Uint8Array(Buffer.from(d.secret, 'base64'))
    this.owner = d.owner ?? this.name
    this.member = this.dir.member(this.name, this.secret)
    this.cache = new Map()
    this.assigned = new Map()
    this.seeds = new Map()
    for (const b of this.batches) this.learn(b as SignedBatch)
  }
}
const SEEDS_SHAPE: M.Shape = { array: { object: { ctx: 'ident', ed: 'base64', x: 'base64' } } }

export type K2Candidate = MultiDeviceCandidate & {
  readonly directory: DeviceDirectory
  readonly ceremonies: Array<{ person: string; device: string; bytesNewToOld: number; bytesOldToNew: number; contexts: number }>
}

export function k2(opts: K2Options = {}): K2Candidate {
  const budget = opts.budget ?? M.PARAM.budget
  const slots = opts.devices ?? 2
  const counterparts = opts.counterpartRevocation ?? true
  const split = opts.mediatorSplit ?? true
  const mode = opts.stock ?? 'strict'
  const producer = opts.producerRule ?? true
  const dir = new DeviceDirectory()
  const devices = new Map<string, K2Device[]>()
  const ceremonies: K2Candidate['ceremonies'] = []
  const secret = () => new Uint8Array(randomBytes(32))
  const make = (person: string, name: string, index: number) => new K2Device(person, name, secret(), index, slots, budget, dir, split, mode, producer, counterparts, opts.stockLifetimeMs)
  const id = mode === 'shared' ? 'k2-shared-stock' : split ? 'k2-device-keys' : 'k2-device-keys-no-split'
  const size = (x: unknown) => Buffer.byteLength(JSON.stringify(x), 'utf8')
  return {
    id,
    title: mode === 'shared' ? 'K2-shared: device keys, device-set@1, stock keys shared by the set' : 'K2-strict: device keys, device-set@1, stock keys per device',
    capabilities: new Set(['journal', 'rights', 'device-keys', 'device-sets'] as const),
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
