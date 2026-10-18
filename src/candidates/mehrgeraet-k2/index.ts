// K2 step 1: device keys (plan E15, section 6o.4 step 1; assumptions 6o.5 no. 1–5
// under Anton's go of 18.10.2026). Every device has its own secret (random,
// never derived from a seed shared by the person); every key of the device
// (pair anchors, self key, stock keys, card keys, the journal signing key)
// derives from that secret per context. The person's seed is not on any
// device: the world still hands one to `first`, K2 ignores it. A thief with
// one device's image therefore holds exactly that device's keys.
//
// K2 reuses K1a's journal, holder and model unchanged (assumption 6o.5 no. 1:
// both K2 cuts keep the K1a journal; "without journal" stays a counter-run):
// batches with writer incarnation and counter, heads, catch-up, the gate after
// restore, fold rules 1–3, re-evaluation of kept probes, the shape table and
// the static acceptance quota per device (MV-9). What changes:
//
// - Keys per device (`deviceScheme`): ed/x for a context `ctx` are
//   sha256(deviceSecret ‖ "ed/" ‖ ctx) and sha256(deviceSecret ‖ "x/" ‖ ctx);
//   K1a used the person's seed in place of the device secret. Context names,
//   relationship ids, tuple ids and record ids are unchanged; the anchor in a
//   tuple, a stock key or a card is the one of the device that created it
//   (recorded anchor), the sibling holds its own key for the same context.
// - Carrier registration per device: each device registers its own rkid for
//   every context it holds, its self address included (one self address per
//   device). The carrier is not told the device set in step 1; the set is a
//   bench-side list held by this candidate (`DeviceDirectory`), until step 2
//   builds `device-set@1`.
// - Counterparts (step-1 simplification, measured nothing about yet): a
//   counterpart learns the device set of a person through the bench list
//   (`recipients`): it seals every document once per device of the current
//   set (one copy per device key, each at that device's own address) and
//   accepts a signature by any device of the set for the context. Revocation
//   updates the list at once (assumption 6o.5 no. 3 is step 3).
// - Journal: every batch is signed by the producing device's journal key
//   (Ed25519 over the canonical batch); the frame around it is signed by the
//   sending device's self key and sealed once per sibling of the current set
//   (fan-out per sibling, each at the sibling's own self address). A sync
//   answer goes only to the requesting device. The fold verifies the batch
//   signature against the device set: a batch whose writer is not in the
//   current set, or whose signature is not its writer's, is the finding
//   `journal:unknown-writer` and never state.
// - Writer of a revision = the signing device key of the relationship (8500 and
//   6270 per signer, `signerId` in holder.ts); no writer tag in the document.
//   Stock: every device numbers its own keys under its own nonce (8430/8445
//   per device); the person's stock is the union. M may name any key (no
//   `n mod devices` split; the per-device stock at M is step 5).
// - Incarnation stays: a restore brings the same device keys back from the
//   image with an older journal, so the batch key must change (MV-3).

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
   * Step-1 simplification: a revocation also removes the device from the list the counterparts read (default on). Off =
   * only the carrier registration and the siblings' list change (counter-run "carrier only", plan 6o.3): counterparts keep
   * sealing to the revoked device.
   */
  counterpartRevocation?: boolean
  /**
   * Counter-run: keep K1a's split of the keys a mediator device may name (n mod devices, `mayName`). Default off (K2 step 1:
   * M names any key of the person's stock; the per-device allocation at M, 4.5 (b), is step 5).
   */
  mediatorSplit?: boolean
}

/** Keys of one device for every context, derived from the device secret; `note` tells the bench list which key is whose. */
export function deviceScheme(secret: Uint8Array, note?: (ctx: string, k: Keys) => void): KeyScheme {
  const cache = new Map<string, Promise<Keys>>()
  return {
    pair(ctx) {
      let p = cache.get(ctx)
      if (!p) {
        p = (async () => {
          const ed = await edFromSeed(derive(secret, `ed/${ctx}`))
          const x = await xFromSeed(derive(secret, `x/${ctx}`))
          const k = { ed, x, anchor: anchorOfEd(ed.pubRaw), rkid: mkOfX(x.pubRaw) }
          note?.(ctx, k)
          return k
        })()
        cache.set(ctx, p)
      }
      return p
    },
  }
}

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
/** The journal signing key of a device (Ed25519 from the device secret, node:crypto: synchronous inside `commit`). */
function journalKey(secret: Uint8Array): { priv: KeyObject; pub: KeyObject; raw: string } {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(derive(secret, 'journal-sign'))]), format: 'der', type: 'pkcs8' })
  const pub = createPublicKey(priv)
  return { priv, pub, raw: pub.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') }
}
/** What the device signs: the batch without its signature, canonical (sorted keys) after a JSON round trip. */
const signedBytes = (b: Omit<SignedBatch, 'sig'>) => Buffer.from(M.canonical(JSON.parse(JSON.stringify(b))))

interface SignedBatch extends Batch {
  /** Ed25519 signature of the producing device over the canonical batch (base64). */
  sig: string
}

interface Member {
  name: string
  secret: Uint8Array
  scheme: KeyScheme
  journal: ReturnType<typeof journalKey>
}

/**
 * The bench-side device list (step 1; step 2 replaces it with `device-set@1` per relationship). Per person: every device
 * ever enrolled, the current set the siblings seal the journal to, and the set the counterparts read (`published`; equal
 * to the current set unless the counter-run keeps a revoked device in it). `byKey` maps every derived public key (anchor
 * and rkid) to the person and context, so a counterpart can find the keys of the other devices for the same context.
 */
export class DeviceDirectory {
  readonly persons = new Map<string, { members: Map<string, Member>; set: string[]; published: string[] }>()
  readonly byKey = new Map<string, { person: string; ctx: string }>()
  /** A fresh world for this person (the candidate object serves several worlds in turn). */
  reset(person: string) {
    this.persons.set(person, { members: new Map(), set: [], published: [] })
  }
  member(person: string, name: string, secret: Uint8Array): Member {
    const note = (ctx: string, k: Keys) => {
      this.byKey.set(k.anchor, { person, ctx })
      this.byKey.set(k.rkid, { person, ctx })
    }
    return { name, secret, scheme: deviceScheme(secret, note), journal: journalKey(secret) }
  }
  /** QR stand-in (6o.5 no. 4): the new device's public material reaches the set; nothing else is measured here. */
  add(person: string, m: Member) {
    const p = this.persons.get(person)!
    p.members.set(m.name, m)
    if (!p.set.includes(m.name)) p.set.push(m.name)
    if (!p.published.includes(m.name)) p.published.push(m.name)
  }
  remove(person: string, name: string, counterparts = true) {
    const p = this.persons.get(person)
    if (!p) return
    p.set = p.set.filter((n) => n !== name)
    if (counterparts) p.published = p.published.filter((n) => n !== name)
  }
  /** Keys of every device of the current set for the context behind `key`; null if `key` is not a device key on the list. */
  async recipients(key: string): Promise<Array<{ anchor: string; rkid: string }> | null> {
    const info = this.byKey.get(key)
    const p = info && this.persons.get(info.person)
    if (!info || !p) return null
    const names = info.ctx.startsWith('self/') ? p.set : p.published
    const out: Array<{ anchor: string; rkid: string }> = []
    for (const n of names) {
      const k = await p.members.get(n)!.scheme.pair(info.ctx)
      out.push({ anchor: k.anchor, rkid: k.rkid })
    }
    return out
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
  constructor(
    person: string,
    name: string,
    secret: Uint8Array,
    index: number,
    slots: number,
    budget: number,
    private readonly dir: DeviceDirectory,
    private readonly nameSplit = false,
  ) {
    super(person, name, new Uint8Array(32), index, slots, budget, false, false) // no writer tags, no number classes
    this.secret = secret
    this.member = dir.member(person, name, secret)
    this.keys = { pair: (ctx) => this.member.scheme.pair(ctx) }
  }
  get public(): Member {
    return this.member
  }
  /** M names any key of the person's stock (no `n mod devices` split in K2; the per-device stock at M is step 5). */
  override mayName(anchor: string, rel: string, state: M.HolderState): boolean {
    return this.nameSplit ? super.mayName(anchor, rel, state) : true
  }
  recipients(key: string) {
    return this.dir.recipients(key)
  }
  async selfPeers() {
    return (await this.dir.selfKeys(this.person)).filter((k) => k.device !== this.name).map(({ anchor, rkid }) => ({ anchor, rkid }))
  }
  async selfDevice(anchor: string): Promise<string | null> {
    return (await this.dir.selfKeys(this.person)).find((k) => k.anchor === anchor)?.device ?? null
  }
  /** Every device numbers its own stock under its own nonce (8430, 8445 per device), stable across a restore. */
  stockNonce(relationship: string): string {
    return Buffer.from(derive(this.secret, `nonce/${relationship}`)).toString('base64')
  }
  override commit(tx: Parameters<K1aDevice['commit']>[0]): void {
    super.commit(tx)
    const b = this.batches[this.batches.length - 1] as SignedBatch
    b.sig = sign(null, signedBytes(b), this.member.journal.priv).toString('base64')
  }
  /**
   * The fold's entry for a journal batch (pure): signature first, against the writer's device key on the current list; a
   * writer outside the set or a signature that is not its writer's is `UnknownWriter` (holder: finding
   * `journal:unknown-writer`, never state, no receipt). Then K1a's shape and order checks on the batch without `sig`.
   */
  override receiveOwnFrame(body: Uint8Array) {
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
    return super.receiveOwnFrame(enc.encode(JSON.stringify(rest)))
  }
  override persist() {
    return { ...super.persist(), secret: Buffer.from(this.secret).toString('base64') }
  }
  override restore(data: unknown): void {
    super.restore(data)
    const d = data as { secret?: string } | null
    if (!d?.secret) return
    this.secret = new Uint8Array(Buffer.from(d.secret, 'base64'))
    this.member = this.dir.member(this.person, this.name, this.secret)
  }
}

export function k2(opts: K2Options = {}): MultiDeviceCandidate & { readonly directory: DeviceDirectory; readonly ceremonies: Array<{ person: string; device: string; bytesNewToOld: number; bytesOldToNew: number }> } {
  const budget = opts.budget ?? M.PARAM.budget
  const slots = opts.devices ?? 2
  const counterparts = opts.counterpartRevocation ?? true
  const split = opts.mediatorSplit ?? false
  const dir = new DeviceDirectory()
  const devices = new Map<string, K2Device[]>()
  const ceremonies: Array<{ person: string; device: string; bytesNewToOld: number; bytesOldToNew: number }> = []
  const secret = () => new Uint8Array(randomBytes(32))
  /** QR stand-in: what one device shows the other (name, self key, journal key), measured as bytes. */
  const qr = async (person: string, m: Member) => {
    const k = await m.scheme.pair(`self/${person}`)
    return Buffer.byteLength(JSON.stringify({ device: m.name, anchor: k.anchor, rkid: k.rkid, journal: m.journal.raw }), 'utf8')
  }
  return {
    id: split ? 'k2-device-keys-split' : 'k2-device-keys',
    title: 'K2 step 1: device keys, registration per device, device-signed journal',
    capabilities: new Set(['journal', 'rights', 'device-keys'] as const),
    directory: dir,
    ceremonies,
    async first(person, name) {
      dir.reset(person) // the seed of the person is ignored: no device holds it
      const d = new K2Device(person, name, secret(), 0, slots, budget, dir, split)
      dir.add(person, d.public)
      devices.set(person, [d])
      return d
    },
    async instance(person, name) {
      // A thief from an image (X9): an independent instance outside the set; `reload` brings the stolen device's secret.
      return new K2Device(person, name, secret(), 0, slots, budget, dir, split)
    },
    async enrol(from: HolderDevice, name, eo?: EnrolOptions) {
      const list = devices.get(from.person) ?? []
      if (list.length >= slots) throw new EnrolmentRefused(`K2: Gerätezahl fest auf ${slots}; Enrollment von ${name} verweigert`)
      if (eo?.fromLog) throw new EnrolmentRefused('K2 Schritt 1: kein Enrollment aus der Ablage')
      const old = from.cand as K2Device
      const d = new K2Device(from.person, name, secret(), list.length, slots, budget, dir, split)
      // QR between the two own devices (6o.5 no. 4): the new device shows its public keys, the old one answers with its own
      // and the current set; the bench list takes the new device (step 1: the counterparts read the same list).
      ceremonies.push({ person: from.person, device: name, bytesNewToOld: await qr(from.person, d.public), bytesOldToNew: await qr(from.person, old.public) })
      dir.add(from.person, d.public)
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
      // Step-1 simplification: the bench list drops the device for the siblings and (unless the counter-run) the counterparts.
      for (const [person, list] of devices) if (list.some((d) => d.name === device)) dir.remove(person, device, counterparts)
    },
    release(person, name) {
      dir.remove(person, name)
      const list = devices.get(person)
      if (list) devices.set(person, list.filter((d) => d.name !== name))
      for (const d of list ?? []) d.forget(name)
    },
  }
}
