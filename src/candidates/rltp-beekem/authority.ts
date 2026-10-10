// Autoritätslog in der Spec-Form (E9, Access 0.56): kausaler DAG signierter
// Operationen, deterministisch gefaltet.
//
// - Jede Operation trägt ein signature-set über ihre Hülle (id = Digest des
//   Körpers ohne Beweise). Ein Signierer zählt, wenn seine Signatur unter dem
//   Schlüssel prüft, den die gültige Aufnahme (oder die Genesis) für ihn im
//   Log registriert hat, und er an der Position Mitglied ist (policy currency).
// - Die Gruppe regiert sich über eine Politik als Daten (§4): je Operation eine
//   Regel aus any-member, threshold, actors, vouch, all, any, strongest.
//   Gültigkeit über Satisfaction-Mengen (§4.4), nicht syntaktisch. Rollen
//   gibt es nicht: „Admin“ ist actors(k=1).
// - Strong Removal wie bisher: eine Entfernung MIT Autorität trifft den Autor
//   einer gleichzeitigen Operation, transitiv; gegenseitige Entfernung: beide.
// - Klassenregel 3 (§3.6, RLTP-ACC-3495): policy.change neben einer
//   Durchsetzung (remove, policy.change) forkt. Beide Geschwister verfallen,
//   im Fork verfällt jede weitere Durchsetzung (fail-closed), Aufnahmen gehen
//   weiter. Ende: ein policy.change, dessen Vorgänger beide Zweige enthalten.
// Ed25519 über @noble/curves (synchron, damit die Faltung synchron bleibt).
// Fixpunkt noch wie E6 (quadratisch); inkrementell ist Folgearbeit.

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'

export type Person = string
export type OpKey = 'member.add' | 'member.remove' | 'policy.change'
export type Rule =
  | { type: 'any-member' }
  | { type: 'threshold'; k: number }
  | { type: 'actors'; actors: Person[]; k: number }
  | { type: 'vouch'; count: number }
  | { type: 'all'; of: Rule[] }
  | { type: 'any'; of: Rule[] }
  | { type: 'strongest' }
export type Policy = Record<OpKey, Rule>

export interface Sig {
  readonly signer: Person
  readonly sig: string
}
/** Bürgschaft für genau eine Aufnahme: Signatur über (Subjekt, Nonce der Aufnahme). */
export interface Vouch {
  readonly voucher: Person
  readonly sig: string
}

export interface AuthOp {
  readonly id: string
  readonly kind: 'create' | 'add' | 'remove' | 'policy'
  readonly subject?: Person
  /** Öffentlicher Schlüssel (hex) des Subjekts bei create/add. */
  readonly key?: string
  readonly policy?: Policy
  /** Gruppenschlüssel (hex) der Genesis; signiert als 'group' mit. */
  readonly group?: string
  readonly nonce: string
  readonly preds: readonly string[]
  /** Beweise, nicht Teil der Hülle. */
  readonly vouches?: readonly Vouch[]
  readonly sigs: readonly Sig[]
}

export type Body =
  | { kind: 'create'; subject: Person; key: string; policy: Policy; group?: string }
  | { kind: 'add'; subject: Person; key: string; vouchers?: Signer[] }
  | { kind: 'remove'; subject: Person }
  | { kind: 'policy'; policy: Policy }

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (h: string) => Uint8Array.from(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? [])
const enc = new TextEncoder()
const digest = (s: string) => hex(sha256(enc.encode(s)))

export class Signer {
  private constructor(readonly name: Person, private readonly priv: Uint8Array, readonly pub: string) {}
  static generate(name: Person) {
    const priv = ed25519.utils.randomSecretKey()
    return new Signer(name, priv, hex(ed25519.getPublicKey(priv)))
  }
  sign(msg: string): string {
    return hex(ed25519.sign(enc.encode(msg), this.priv))
  }
}

const verifyCache = new Map<string, boolean>()
function verify(sig: string, msg: string, pub: string): boolean {
  const k = `${pub}|${msg}|${sig}`
  let r = verifyCache.get(k)
  if (r === undefined) {
    try {
      r = ed25519.verify(unhex(sig), enc.encode(msg), unhex(pub))
    } catch {
      r = false
    }
    verifyCache.set(k, r)
  }
  return r
}

const vouchMsg = (subject: Person, nonce: string) => `vouch|${subject}|${nonce}`
/** Die Hülle: alles außer Beweisen. Signiert wird ihr Digest, und der ist die id. */
const hullDigest = (h: Pick<AuthOp, 'kind' | 'subject' | 'key' | 'policy' | 'group' | 'nonce' | 'preds'>) =>
  digest(JSON.stringify({ kind: h.kind, subject: h.subject, key: h.key, policy: h.policy, group: h.group, nonce: h.nonce, preds: h.preds }))

interface State {
  created: boolean
  members: Set<Person>
  keys: Map<Person, string>
  policy: Policy | undefined
  policyVersion: number
}
const emptyState = (): State => ({ created: false, members: new Set(), keys: new Map(), policy: undefined, policyVersion: 0 })

/** Beweislage einer Operation: Signierer A und Bürgen P (§4.4), plus das Ja des Subjekts. */
interface Situation {
  A: Set<Person>
  P: Set<Person>
  subjectConsent: boolean
}

const KEYS: OpKey[] = ['member.add', 'member.remove', 'policy.change']
const opKey = (op: AuthOp): OpKey | undefined => (op.kind === 'add' ? 'member.add' : op.kind === 'remove' ? 'member.remove' : op.kind === 'policy' ? 'policy.change' : undefined)
const isEnforcement = (op: AuthOp) => op.kind === 'remove' || op.kind === 'policy'

export class AuthorityLog {
  private readonly opsById = new Map<string, AuthOp>()
  private cache: { valid: Set<string>; state: State; forked: boolean } | undefined

  /** Neue signierte Operation auf den aktuellen Köpfen (oder den genannten). */
  make(body: Body, signers: Signer[], preds: string[] = this.heads()): AuthOp {
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
    const hull = {
      kind: body.kind,
      subject: 'subject' in body ? body.subject : undefined,
      key: 'key' in body ? body.key : undefined,
      policy: 'policy' in body ? body.policy : undefined,
      group: body.kind === 'create' ? body.group : undefined,
      nonce,
      preds,
    }
    const id = hullDigest(hull)
    const vouches = body.kind === 'add' ? (body.vouchers ?? []).map((v) => ({ voucher: v.name, sig: v.sign(vouchMsg(body.subject, nonce)) })) : undefined
    const sigs = signers.map((s) => ({ signer: s.name, sig: s.sign(id) }))
    return { ...hull, id, vouches, sigs }
  }

  /** Nimmt eine Operation auf; 'wartet', wenn Vorgänger fehlen. Prüft nichts: Gültigkeit entscheidet die Faltung. */
  add(op: AuthOp): 'neu' | 'bekannt' | 'wartet' {
    if (this.opsById.has(op.id)) return 'bekannt'
    if (!op.preds.every((p) => this.opsById.has(p))) return 'wartet'
    this.opsById.set(op.id, op)
    this.cache = undefined
    return 'neu'
  }

  has(id: string) {
    return this.opsById.has(id)
  }
  ops(): AuthOp[] {
    return [...this.opsById.values()]
  }

  heads(): string[] {
    const referenced = new Set<string>()
    for (const op of this.opsById.values()) for (const p of op.preds) referenced.add(p)
    return [...this.opsById.keys()].filter((id) => !referenced.has(id)).sort()
  }

  /** Mitglieder nach allen gültigen Operationen. */
  members(): Set<Person> {
    return new Set(this.fold().state.members)
  }
  keyOf(p: Person): string | undefined {
    return this.fold().state.keys.get(p)
  }
  policy(): Policy {
    return this.fold().state.policy ?? ({} as Policy)
  }
  policyVersion(): number {
    return this.fold().state.policyVersion
  }
  forked(): boolean {
    return this.fold().forked
  }
  isValid(id: string): boolean {
    return this.fold().valid.has(id)
  }

  /** Darf diese Person die Operation allein, nach der geltenden Politik? */
  may(p: Person, key: OpKey): boolean {
    const st = this.fold().state
    if (!st.policy || !st.members.has(p)) return false
    return this.sat(st.policy[key], { A: new Set([p]), P: new Set(), subjectConsent: false }, undefined, st.members, st.policy, key)
  }

  /** Ordnung aus §4.4 über Satisfaction-Mengen, an der aktuellen Mitgliedschaft. */
  compare(r1: Rule, r2: Rule): '=' | '>=' | '<' | 'incomparable' {
    const st = this.fold().state
    return this.order(r1, r2, st.members, st.policy, undefined)
  }

  // ── Politik ─────────────────────────────────────────────────────────────

  private structurallyValid(policy: Policy): boolean {
    if (!policy || typeof policy !== 'object') return false
    const check = (r: Rule, depth: number, key: OpKey, top: boolean): boolean => {
      if (!r || depth > 4) return false
      switch (r.type) {
        case 'any-member':
          return true
        case 'threshold':
          return Number.isInteger(r.k) && r.k >= 1
        case 'actors':
          return Array.isArray(r.actors) && r.actors.length > 0 && new Set(r.actors).size === r.actors.length && Number.isInteger(r.k) && r.k >= 1 && r.k <= r.actors.length
        case 'vouch':
          return key === 'member.add' && Number.isInteger(r.count) && r.count >= 1 && r.count <= 16
        case 'all':
        case 'any':
          return Array.isArray(r.of) && r.of.length > 0 && r.of.every((x) => check(x, depth + 1, key, false))
        case 'strongest':
          return top
        default:
          return false
      }
    }
    if (!KEYS.every((k) => check(policy[k], 1, k, true))) return false
    return KEYS.some((k) => policy[k].type !== 'strongest')
  }

  private assignable = (r: Rule, key: OpKey): boolean => {
    if (r.type === 'vouch') return key === 'member.add'
    if (r.type === 'all' || r.type === 'any') return r.of.every((x) => this.assignable(x, key))
    return r.type !== 'strongest'
  }
  private hasVouch = (r: Rule): boolean => r.type === 'vouch' || ((r.type === 'all' || r.type === 'any') && r.of.some(this.hasVouch))

  private sat(rule: Rule, s: Situation, subject: Person | undefined, currency: Set<Person>, policy: Policy, key: OpKey): boolean {
    const inC = (set: Set<Person>) => [...set].filter((p) => currency.has(p))
    switch (rule.type) {
      case 'any-member':
        return inC(s.A).length >= 1
      case 'threshold':
        return inC(s.A).length >= rule.k
      case 'actors':
        return inC(s.A).filter((p) => rule.actors.includes(p)).length >= rule.k
      case 'vouch':
        return subject !== undefined && s.subjectConsent && inC(s.P).length >= rule.count
      case 'all':
        return rule.of.every((r) => this.sat(r, s, subject, currency, policy, key))
      case 'any':
        return rule.of.some((r) => this.sat(r, s, subject, currency, policy, key))
      case 'strongest': {
        const resolved = this.resolveStrongest(policy, key, currency, subject)
        return resolved ? this.sat(resolved, s, subject, currency, policy, key) : false
      }
    }
  }

  /** strongest = all[maximale Elemente der konkreten, zuweisbaren Regeln unter ≥]. */
  private resolveStrongest(policy: Policy, key: OpKey, currency: Set<Person>, subject: Person | undefined): Rule | undefined {
    const rest = KEYS.map((k) => policy[k]).filter((r) => r.type !== 'strongest' && this.assignable(r, key))
    if (!rest.length) return undefined
    const maxima = rest.filter((r) => !rest.some((o) => o !== r && this.order(o, r, currency, policy, subject) === '>='))
    return { type: 'all', of: maxima }
  }

  /** Aufzählung über das endliche Universum (Signierer ⊆ currency, Bürgen ⊆ currency, Ja des Subjekts). */
  private order(r1: Rule, r2: Rule, currency: Set<Person>, policy: Policy | undefined, subject: Person | undefined): '=' | '>=' | '<' | 'incomparable' {
    const people = [...currency]
    if (people.length > 16) throw new Error(`Ordnung über ${people.length} Mitglieder nicht aufgezählt (E9: Schranke 16)`)
    const withVouch = this.hasVouch(r1) || this.hasVouch(r2)
    const p = policy ?? ({} as Policy)
    const key: OpKey = subject ? 'member.add' : 'policy.change'
    let sub = true
    let sup = true
    const n = 1 << people.length
    for (let a = 0; a < n && (sub || sup); a++) {
      const A = new Set(people.filter((_, i) => a & (1 << i)))
      const vouchSets = withVouch ? Array.from({ length: n }, (_, v) => new Set(people.filter((_, i) => v & (1 << i)))) : [new Set<Person>()]
      const consents = withVouch ? [true, false] : [false]
      for (const P of vouchSets) {
        for (const subjectConsent of consents) {
          const s = { A, P, subjectConsent }
          const in1 = this.sat(r1, s, subject, currency, p, key)
          const in2 = this.sat(r2, s, subject, currency, p, key)
          if (in1 && !in2) sub = false
          if (in2 && !in1) sup = false
        }
      }
    }
    if (sub && sup) return '='
    if (sub) return '>='
    if (sup) return '<'
    return 'incomparable'
  }

  // ── Faltung ─────────────────────────────────────────────────────────────

  /** Topologische Ordnung, Gleichstand nach id. */
  private topo(): AuthOp[] {
    const indeg = new Map<string, number>()
    const children = new Map<string, string[]>()
    for (const op of this.opsById.values()) {
      indeg.set(op.id, op.preds.length)
      for (const p of op.preds) children.set(p, [...(children.get(p) ?? []), op.id])
    }
    const ready = [...indeg].filter(([, n]) => n === 0).map(([id]) => id).sort()
    const out: AuthOp[] = []
    while (ready.length) {
      const id = ready.shift()!
      out.push(this.opsById.get(id)!)
      for (const c of (children.get(id) ?? []).sort()) {
        const n = indeg.get(c)! - 1
        indeg.set(c, n)
        if (n === 0) ready.push(c), ready.sort()
      }
    }
    return out
  }

  private ancestors(order: AuthOp[]): Map<string, Set<string>> {
    const anc = new Map<string, Set<string>>()
    for (const op of order) {
      const s = new Set<string>([op.id])
      for (const p of op.preds) for (const a of anc.get(p)!) s.add(a)
      anc.set(op.id, s)
    }
    return anc
  }

  private apply(st: State, op: AuthOp) {
    switch (op.kind) {
      case 'create':
        st.created = true
        st.members.add(op.subject!)
        st.keys.set(op.subject!, op.key!)
        st.policy = op.policy
        st.policyVersion = 1
        break
      case 'add':
        st.members.add(op.subject!)
        st.keys.set(op.subject!, op.key!)
        break
      case 'remove':
        st.members.delete(op.subject!)
        break
      case 'policy':
        st.policy = op.policy
        st.policyVersion += 1
        break
    }
  }

  /** Beweislage: welche Signaturen und Bürgschaften prüfen unter den registrierten Schlüsseln. */
  private situation(op: AuthOp, st: State): Situation {
    const A = new Set<Person>()
    let subjectConsent = false
    for (const s of op.sigs) {
      const k = st.keys.get(s.signer)
      if (k && st.members.has(s.signer) && verify(s.sig, op.id, k)) A.add(s.signer)
      if (op.kind === 'add' && s.signer === op.subject && op.key && verify(s.sig, op.id, op.key)) subjectConsent = true
    }
    const P = new Set<Person>()
    for (const v of op.vouches ?? []) {
      const k = st.keys.get(v.voucher)
      if (k && st.members.has(v.voucher) && op.subject && verify(v.sig, vouchMsg(op.subject, op.nonce), k)) P.add(v.voucher)
    }
    return { A, P, subjectConsent }
  }

  private authorized(op: AuthOp, st: State): boolean {
    // Eine Hülle, die nicht zu ihrer id passt, ist nicht die signierte Hülle.
    if (hullDigest(op) !== op.id) return false
    if (op.kind === 'create') {
      if (st.created || !op.subject || !op.key || !op.policy || !this.structurallyValid(op.policy)) return false
      const founder = op.sigs.some((s) => s.signer === op.subject && verify(s.sig, op.id, op.key!))
      const group = !op.group || op.sigs.some((s) => s.signer === 'group' && verify(s.sig, op.id, op.group!))
      return founder && group
    }
    if (!st.created || !st.policy) return false
    const key = opKey(op)!
    if (op.kind === 'add' && (!op.subject || !op.key)) return false
    if (op.kind === 'remove' && (!op.subject || !st.members.has(op.subject))) return false
    if (op.kind === 'policy' && (!op.policy || !this.structurallyValid(op.policy))) return false
    const s = this.situation(op, st)
    return this.sat(st.policy[key], s, op.subject, st.members, st.policy, key)
  }

  private fold() {
    if (this.cache) return this.cache
    const order = this.topo()
    const anc = this.ancestors(order)
    const concurrent = (a: AuthOp, b: AuthOp) => a.id !== b.id && !anc.get(a.id)!.has(b.id) && !anc.get(b.id)!.has(a.id)
    let valid = new Set(order.map((o) => o.id))
    let forks: Array<[AuthOp, AuthOp]> = []
    let joins = new Set<string>()
    // Fixpunkt. Jede Runde prüft jede Operation neu; Schranke gegen Pendeln.
    for (let round = 0; round <= order.length + 1; round++) {
      // 1. Autorität an jeder Position: Zustand nach den gültigen Vorfahren.
      const authorized = new Set<string>()
      for (const op of order) {
        const st = emptyState()
        for (const prior of order) {
          if (prior.id === op.id || !anc.get(op.id)!.has(prior.id) || !valid.has(prior.id)) continue
          this.apply(st, prior)
        }
        if (this.authorized(op, st)) authorized.add(op.id)
      }
      // 2. Strong Removal: nur eine Entfernung MIT Autorität trifft den Autor
      //    (= einen ihrer gültigen Signierer) einer gleichzeitigen Operation.
      const next = new Set<string>()
      const signersOf = (op: AuthOp) => new Set(op.sigs.map((s) => s.signer))
      for (const op of order) {
        if (!authorized.has(op.id)) continue
        const mine = signersOf(op)
        const removedBy = order.filter((r) => authorized.has(r.id) && r.kind === 'remove' && mine.has(r.subject!) && concurrent(r, op))
        const mutual = op.kind === 'remove' && removedBy.some((r) => signersOf(r).has(op.subject!))
        if (removedBy.length && !mutual) continue
        next.add(op.id)
      }
      // 3. Klassenregel 3: policy.change neben Durchsetzung → beide verfallen;
      //    im Fork verfällt jede Durchsetzung bis zu einem policy.change auf beide.
      const live = order.filter((o) => next.has(o.id))
      forks = []
      for (const p of live) {
        if (p.kind !== 'policy') continue
        for (const q of live) {
          if (q.id <= p.id && q.kind === 'policy') continue // jedes Paar einmal
          if (isEnforcement(q) && concurrent(p, q)) forks.push([p, q])
        }
      }
      joins = new Set()
      for (const [p, q] of forks) {
        next.delete(p.id)
        next.delete(q.id)
        for (const op of live) {
          const a = anc.get(op.id)!
          if (op.id === p.id || op.id === q.id || (!a.has(p.id) && !a.has(q.id))) continue
          if (op.kind === 'policy' && a.has(p.id) && a.has(q.id)) {
            joins.add(op.id)
            continue
          }
          const afterJoin = [...joins].some((j) => a.has(j))
          if (isEnforcement(op) && !afterJoin) next.delete(op.id)
        }
      }
      const same = next.size === valid.size && [...next].every((id) => valid.has(id))
      valid = next
      if (same) break
    }
    const state = emptyState()
    for (const op of order) if (valid.has(op.id)) this.apply(state, op)
    const forked = forks.some(([p, q]) => ![...joins].some((j) => valid.has(j) && anc.get(j)!.has(p.id) && anc.get(j)!.has(q.id)))
    this.cache = { valid, state, forked }
    return this.cache
  }
}
