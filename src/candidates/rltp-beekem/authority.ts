// Minimales Autoritätslog nach der Konfliktmatrix (Synthese §5):
// kausaler DAG von Mitgliedschaftsoperationen, deterministisch gefaltet.
//
// Regeln:
// - Gültig ist eine Operation, deren Autor an ihrer Position Admin ist
//   (`create` nur einmal, der Gründer wird Admin ohne Sonderrolle danach).
// - Strong Removal: Wird der Autor von einer gleichzeitigen, gültigen
//   Entfernung getroffen, ist seine Operation ungültig, und damit transitiv
//   alles, was auf ihr aufbaut (Matrix (a), (b), (d)).
// - Gegenseitige Entfernung (A entfernt B, B entfernt A gleichzeitig): beide
//   gelten, beide sind raus (Vorschlag der Synthese, Entscheidung 2).
// - Zwei Entfernungen verschiedener Personen gleichzeitig: beide gelten.
// Keine Gruppenregeln, keine Signaturen (Experiment; Fälschung ist nicht Thema).

export type Role = 'admin' | 'member'
export interface AuthOp {
  readonly id: string
  readonly kind: 'create' | 'add' | 'remove'
  readonly author: string
  readonly subject: string
  readonly role?: Role
  readonly preds: readonly string[]
}

async function sha256Hex(s: string): Promise<string> {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export class AuthorityLog {
  private readonly ops = new Map<string, AuthOp>()
  private cache: { valid: Set<string>; members: Map<string, Role> } | undefined

  /** Neue Operation auf den aktuellen Köpfen. */
  async make(kind: AuthOp['kind'], author: string, subject: string, role?: Role): Promise<AuthOp> {
    const preds = this.heads()
    const body = JSON.stringify({ kind, author, subject, role: role ?? null, preds })
    return { id: await sha256Hex(body), kind, author, subject, role, preds }
  }

  /** Nimmt eine Operation auf; false, wenn schon bekannt oder Vorgänger fehlen. */
  add(op: AuthOp): 'neu' | 'bekannt' | 'wartet' {
    if (this.ops.has(op.id)) return 'bekannt'
    if (!op.preds.every((p) => this.ops.has(p))) return 'wartet'
    this.ops.set(op.id, op)
    this.cache = undefined
    return 'neu'
  }

  has(id: string) {
    return this.ops.has(id)
  }

  heads(): string[] {
    const referenced = new Set<string>()
    for (const op of this.ops.values()) for (const p of op.preds) referenced.add(p)
    return [...this.ops.keys()].filter((id) => !referenced.has(id)).sort()
  }

  /** Mitglieder mit Rolle nach allen gültigen Operationen. */
  members(): Map<string, Role> {
    return new Map(this.fold().members)
  }

  isValid(id: string): boolean {
    return this.fold().valid.has(id)
  }

  /** Topologische Ordnung, Gleichstand nach id. */
  private order(): AuthOp[] {
    const indeg = new Map<string, number>()
    const children = new Map<string, string[]>()
    for (const op of this.ops.values()) {
      indeg.set(op.id, op.preds.length)
      for (const p of op.preds) children.set(p, [...(children.get(p) ?? []), op.id])
    }
    const ready = [...indeg].filter(([, n]) => n === 0).map(([id]) => id).sort()
    const out: AuthOp[] = []
    while (ready.length) {
      const id = ready.shift()!
      out.push(this.ops.get(id)!)
      for (const c of (children.get(id) ?? []).sort()) {
        const n = indeg.get(c)! - 1
        indeg.set(c, n)
        if (n === 0) ready.push(c), ready.sort()
      }
    }
    return out
  }

  /** Vorfahren je Operation (inkl. sich selbst), für Gleichzeitigkeit. */
  private ancestors(order: AuthOp[]): Map<string, Set<string>> {
    const anc = new Map<string, Set<string>>()
    for (const op of order) {
      const s = new Set<string>([op.id])
      for (const p of op.preds) for (const a of anc.get(p)!) s.add(a)
      anc.set(op.id, s)
    }
    return anc
  }

  private fold() {
    if (this.cache) return this.cache
    const order = this.order()
    const anc = this.ancestors(order)
    const concurrent = (a: AuthOp, b: AuthOp) => a.id !== b.id && !anc.get(a.id)!.has(b.id) && !anc.get(b.id)!.has(a.id)
    let valid = new Set(order.map((o) => o.id))
    // Fixpunkt: Ungültigkeit kann weitere Operationen ungültig machen, nie umgekehrt.
    for (;;) {
      const next = new Set<string>()
      // Zustand an jeder Position: Mitglieder nach den gültigen Vorfahren.
      for (const op of order) {
        if (!valid.has(op.id)) continue
        const state = new Map<string, Role>()
        let created = false
        for (const prior of order) {
          if (prior.id === op.id || !anc.get(op.id)!.has(prior.id) || !valid.has(prior.id)) continue
          apply(state, prior)
          if (prior.kind === 'create') created = true
        }
        const authorIsAdmin = state.get(op.author) === 'admin'
        const ok = op.kind === 'create' ? !created && op.author === op.subject : authorIsAdmin
        if (!ok) continue
        // Strong Removal: gleichzeitige gültige Entfernung des Autors.
        const removedBy = order.filter((r) => valid.has(r.id) && r.kind === 'remove' && r.subject === op.author && concurrent(r, op))
        const mutual = op.kind === 'remove' && removedBy.some((r) => r.author === op.subject)
        if (removedBy.length && !mutual) continue
        next.add(op.id)
      }
      if (next.size === valid.size) break
      valid = next
    }
    const members = new Map<string, Role>()
    for (const op of order) if (valid.has(op.id)) apply(members, op)
    this.cache = { valid, members }
    return this.cache
  }
}

function apply(state: Map<string, Role>, op: AuthOp) {
  if (op.kind === 'create') state.set(op.subject, 'admin')
  else if (op.kind === 'add') state.set(op.subject, op.role ?? 'member')
  else state.delete(op.subject)
}
