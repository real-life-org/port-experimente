import { describe, expect, it } from 'vitest'
import { AuthorityLog, Signer, type AuthOp, type Policy } from '../src/candidates/rltp-beekem/authority'

// E9: Das Autoritätslog in der Spec-Form (Access 0.56): jede Operation trägt
// ein signature-set über ihre Hülle, die Gruppe regiert sich über eine
// Politik als Daten (§4), policy.change neben Durchsetzung forkt (§3.6).
// Rollen gibt es nicht mehr: „Admin“ ist actors(k=1).

const people = ['alice', 'bob', 'carol', 'dave', 'eve', 'x', 'y', 'mallory'] as const
const key = Object.fromEntries(people.map((p) => [p, Signer.generate(p)])) as Record<(typeof people)[number], Signer>

/** Politik, in der die genannten Personen allein aufnehmen, entfernen und die Regeln ändern dürfen. */
const admins = (...who: string[]): Policy => ({
  'member.add': { type: 'actors', actors: who, k: 1 },
  'member.remove': { type: 'actors', actors: who, k: 1 },
  'policy.change': { type: 'actors', actors: who, k: 1 },
})

/** Alice gründet, nimmt Bob (mit-Admin), Carol und Dave auf. */
async function setup() {
  const a = new AuthorityLog()
  a.add(await a.make({ kind: 'create', subject: 'alice', key: key.alice.pub, policy: admins('alice') }, [key.alice]))
  a.add(await a.make({ kind: 'add', subject: 'bob', key: key.bob.pub }, [key.alice]))
  a.add(await a.make({ kind: 'policy', policy: admins('alice', 'bob') }, [key.alice]))
  a.add(await a.make({ kind: 'add', subject: 'carol', key: key.carol.pub }, [key.alice]))
  a.add(await a.make({ kind: 'add', subject: 'dave', key: key.dave.pub }, [key.alice]))
  return a
}
const clone = (ops: AuthOp[]) => {
  const b = new AuthorityLog()
  // Reihenfolge der Zustellung darf keine Rolle spielen: rückwärts, mit Warteschleife.
  let pending = [...ops].reverse()
  while (pending.length) {
    const rest: AuthOp[] = []
    for (const op of pending) if (b.add(op) === 'wartet') rest.push(op)
    if (rest.length === pending.length) throw new Error('Vorgänger fehlen dauerhaft')
    pending = rest
  }
  return b
}
const names = (m: Iterable<string>) => [...m].sort()
/** Dieselbe Operation auf anderen Vorgängern (gleichzeitig), neu signiert. */
const on = (a: AuthorityLog, preds: string[]) => ({
  make: (body: Parameters<AuthorityLog['make']>[0], signers: Signer[]) => a.make(body, signers, preds),
})

describe('E9 Autoritätslog: Matrix wie bisher', () => {
  it('Nicht-Admin darf nicht aufnehmen', async () => {
    const a = await setup()
    a.add(await a.make({ kind: 'add', subject: 'eve', key: key.eve.pub }, [key.carol]))
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave'])
  })

  it('zwei gleichzeitige Entfernungen verschiedener Personen gelten beide', async () => {
    const a = await setup()
    const heads = a.heads()
    a.add(await on(a, heads).make({ kind: 'remove', subject: 'carol' }, [key.alice]))
    a.add(await on(a, heads).make({ kind: 'remove', subject: 'dave' }, [key.bob]))
    expect(names(a.members())).toEqual(['alice', 'bob'])
  })

  it('gegenseitige Entfernung: beide raus', async () => {
    const a = await setup()
    const heads = a.heads()
    a.add(await on(a, heads).make({ kind: 'remove', subject: 'bob' }, [key.alice]))
    a.add(await on(a, heads).make({ kind: 'remove', subject: 'alice' }, [key.bob]))
    expect(names(a.members())).toEqual(['carol', 'dave'])
  })

  it('Strong Removal: Aufnahme durch gleichzeitig Entfernten ist ungültig, transitiv', async () => {
    const a = await setup()
    const heads = a.heads()
    const rmBob = await on(a, heads).make({ kind: 'remove', subject: 'bob' }, [key.alice])
    const addX = await on(a, heads).make({ kind: 'add', subject: 'x', key: key.x.pub }, [key.bob])
    a.add(rmBob)
    a.add(addX)
    const promoteX = await a.make({ kind: 'policy', policy: admins('alice', 'bob', 'x') }, [key.bob])
    a.add(promoteX)
    const addY = await a.make({ kind: 'add', subject: 'y', key: key.y.pub }, [key.x])
    a.add(addY)
    expect(names(a.members())).toEqual(['alice', 'carol', 'dave'])
    expect(a.isValid(addX.id)).toBe(false)
    expect(a.isValid(promoteX.id)).toBe(false)
    expect(a.isValid(addY.id)).toBe(false)
  })

  it('Gründerin ohne Sonderrolle: ein anderer Admin kann sie entfernen', async () => {
    const a = await setup()
    a.add(await a.make({ kind: 'remove', subject: 'alice' }, [key.bob]))
    expect(names(a.members())).toEqual(['bob', 'carol', 'dave'])
    a.add(await a.make({ kind: 'remove', subject: 'dave' }, [key.bob]))
    expect(names(a.members())).toEqual(['bob', 'carol'])
  })

  it('unberechtigte gleichzeitige Entfernung unterdrückt keine gültige Aufnahme (Review #11)', async () => {
    const a = await setup()
    const heads = a.heads()
    const addEve = await on(a, heads).make({ kind: 'add', subject: 'eve', key: key.eve.pub }, [key.alice])
    const rmAlice = await on(a, heads).make({ kind: 'remove', subject: 'alice' }, [key.carol]) // Carol ist kein Admin
    a.add(addEve)
    a.add(rmAlice)
    expect(a.isValid(rmAlice.id)).toBe(false)
    expect(a.isValid(addEve.id)).toBe(true)
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave', 'eve'])
  })

  it('Zustellreihenfolge ändert das Ergebnis nicht', async () => {
    const a = await setup()
    const heads = a.heads()
    a.add(await on(a, heads).make({ kind: 'remove', subject: 'bob' }, [key.alice]))
    a.add(await on(a, heads).make({ kind: 'add', subject: 'x', key: key.x.pub }, [key.bob]))
    const b = clone(a.ops())
    expect(names(b.members())).toEqual(names(a.members()))
    expect(b.heads()).toEqual(a.heads())
  })
})

describe('S4g: Signaturen', () => {
  it('ohne Signatur gilt nichts', async () => {
    const a = await setup()
    const op = await a.make({ kind: 'remove', subject: 'carol' }, [key.alice])
    a.add({ ...op, sigs: [] })
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave'])
  })

  it('eine gefälschte Signatur gilt nicht', async () => {
    const a = await setup()
    const op = await a.make({ kind: 'remove', subject: 'carol' }, [key.alice])
    const sig = op.sigs[0]!
    const flipped = sig.sig.slice(0, -2) + (sig.sig.endsWith('00') ? '01' : '00')
    a.add({ ...op, sigs: [{ ...sig, sig: flipped }] })
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave'])
  })

  it('eine fremde Unterschrift unter Alices Namen gilt nicht', async () => {
    const a = await setup()
    const op = await a.make({ kind: 'remove', subject: 'carol' }, [key.mallory])
    a.add({ ...op, sigs: [{ signer: 'alice', sig: op.sigs[0]!.sig }] })
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave'])
  })

  it('die Hülle ist signiert: ein nachträglich geändertes Subjekt gilt nicht', async () => {
    const a = await setup()
    const op = await a.make({ kind: 'remove', subject: 'carol' }, [key.alice])
    a.add({ ...op, subject: 'dave' })
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave'])
  })

  it('Genesis trägt die Signatur des Gruppenschlüssels und der Gründerin', async () => {
    const a = new AuthorityLog()
    const group = Signer.generate('group')
    const genesis = await a.make({ kind: 'create', subject: 'alice', key: key.alice.pub, policy: admins('alice'), group: group.pub }, [key.alice, group])
    a.add(genesis)
    expect(a.isValid(genesis.id)).toBe(true)
    const b = new AuthorityLog()
    b.add({ ...genesis, sigs: genesis.sigs.filter((s) => s.signer !== 'group') })
    expect(b.isValid(genesis.id)).toBe(false)
  })
})

describe('S4h: threshold ist keine Summe über Operationen', () => {
  const twoOfThem = (): Policy => ({ ...admins('alice', 'bob'), 'member.remove': { type: 'threshold', k: 2 } })

  it('eine Signatur reicht nicht, zwei auf derselben Operation schon', async () => {
    const a = await setup()
    a.add(await a.make({ kind: 'policy', policy: twoOfThem() }, [key.alice]))
    a.add(await a.make({ kind: 'remove', subject: 'carol' }, [key.alice]))
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave'])
    a.add(await a.make({ kind: 'remove', subject: 'carol' }, [key.alice, key.bob]))
    expect(names(a.members())).toEqual(['alice', 'bob', 'dave'])
  })

  it('zwei gleichzeitige Einzelsignaturen bilden keine Entfernung', async () => {
    const a = await setup()
    a.add(await a.make({ kind: 'policy', policy: twoOfThem() }, [key.alice]))
    const heads = a.heads()
    a.add(await on(a, heads).make({ kind: 'remove', subject: 'carol' }, [key.alice]))
    a.add(await on(a, heads).make({ kind: 'remove', subject: 'carol' }, [key.bob]))
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave'])
  })

  it('Nicht-Mitglieder zählen nicht zum Quorum', async () => {
    const a = await setup()
    a.add(await a.make({ kind: 'policy', policy: twoOfThem() }, [key.alice]))
    a.add(await a.make({ kind: 'remove', subject: 'carol' }, [key.alice, key.mallory]))
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave'])
  })
})

describe('S4i: vouch gilt für genau diese Aufnahme', () => {
  const vouched = (): Policy => ({ ...admins('alice', 'bob'), 'member.add': { type: 'all', of: [{ type: 'actors', actors: ['alice', 'bob'], k: 1 }, { type: 'vouch', count: 2 }] } })

  it('eine Bürgschaft ist zu wenig, zwei reichen', async () => {
    const a = await setup()
    a.add(await a.make({ kind: 'policy', policy: vouched() }, [key.alice]))
    const one = await a.make({ kind: 'add', subject: 'eve', key: key.eve.pub, vouchers: [key.carol] }, [key.alice, key.eve])
    a.add(one)
    expect(a.isValid(one.id)).toBe(false)
    const two = await a.make({ kind: 'add', subject: 'eve', key: key.eve.pub, vouchers: [key.carol, key.dave] }, [key.alice, key.eve])
    a.add(two)
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave', 'eve'])
  })

  it('ohne das Ja des Subjekts keine Aufnahme', async () => {
    const a = await setup()
    a.add(await a.make({ kind: 'policy', policy: vouched() }, [key.alice]))
    const op = await a.make({ kind: 'add', subject: 'eve', key: key.eve.pub, vouchers: [key.carol, key.dave] }, [key.alice])
    a.add(op)
    expect(a.isValid(op.id)).toBe(false)
  })

  it('Bürgschaften einer anderen Aufnahme zählen nicht', async () => {
    const a = await setup()
    a.add(await a.make({ kind: 'policy', policy: vouched() }, [key.alice]))
    const first = await a.make({ kind: 'add', subject: 'eve', key: key.eve.pub, vouchers: [key.carol, key.dave] }, [key.alice, key.eve])
    const second = await a.make({ kind: 'add', subject: 'eve', key: key.eve.pub, vouchers: [] }, [key.alice, key.eve])
    a.add({ ...second, vouches: first.vouches })
    expect(a.isValid(second.id)).toBe(false)
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave'])
  })

  it('vouch auf member.remove ist strukturell ungültig: die Regeländerung gilt nicht', async () => {
    const a = await setup()
    const bad = await a.make({ kind: 'policy', policy: { ...admins('alice'), 'member.remove': { type: 'vouch', count: 1 } } }, [key.alice])
    a.add(bad)
    expect(a.isValid(bad.id)).toBe(false)
    expect(a.policy()['member.remove']).toEqual({ type: 'actors', actors: ['alice', 'bob'], k: 1 })
  })
})

describe('strongest', () => {
  it('löst zur stärksten konkreten Regel auf, nach Satisfaction-Mengen', async () => {
    const a = await setup()
    const p: Policy = {
      'member.add': { type: 'any-member' },
      'member.remove': { type: 'actors', actors: ['alice', 'bob'], k: 2 },
      'policy.change': { type: 'strongest' },
    }
    a.add(await a.make({ kind: 'policy', policy: p }, [key.alice]))
    // strongest = all[actors({alice,bob},2)]: Alice allein reicht nicht.
    const weak = await a.make({ kind: 'policy', policy: admins('alice') }, [key.alice])
    a.add(weak)
    expect(a.isValid(weak.id)).toBe(false)
    const strong = await a.make({ kind: 'policy', policy: admins('alice') }, [key.alice, key.bob])
    a.add(strong)
    expect(a.isValid(strong.id)).toBe(true)
  })

  it('kennt die Ordnung aus §4.4: all[actors(a),actors(b)] ≥ threshold(2)', async () => {
    const a = await setup()
    const order = a.compare(
      { type: 'all', of: [{ type: 'actors', actors: ['alice'], k: 1 }, { type: 'actors', actors: ['bob'], k: 1 }] },
      { type: 'threshold', k: 2 },
    )
    expect(order).toBe('>=')
    expect(a.compare({ type: 'actors', actors: ['alice', 'bob'], k: 2 }, { type: 'actors', actors: ['alice'], k: 1 })).toBe('>=')
    expect(a.compare({ type: 'any-member' }, { type: 'threshold', k: 2 })).toBe('<')
  })
})

describe('Fork: policy.change neben Durchsetzung', () => {
  it('zwei gleichzeitige policy.change forken; beide verfallen; ein drittes auf beide beendet es', async () => {
    const a = await setup()
    const heads = a.heads()
    const pa = await on(a, heads).make({ kind: 'policy', policy: admins('alice') }, [key.alice])
    const pb = await on(a, heads).make({ kind: 'policy', policy: admins('bob') }, [key.bob])
    a.add(pa)
    a.add(pb)
    expect(a.forked()).toBe(true)
    expect(a.isValid(pa.id)).toBe(false)
    expect(a.isValid(pb.id)).toBe(false)
    expect(a.policy()).toEqual(admins('alice', 'bob'))
    // Im Fork verfällt Durchsetzung (fail-closed); Aufnahmen gehen weiter.
    const rm = await a.make({ kind: 'remove', subject: 'carol' }, [key.alice])
    a.add(rm)
    expect(a.isValid(rm.id)).toBe(false)
    a.add(await a.make({ kind: 'add', subject: 'eve', key: key.eve.pub }, [key.alice]))
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave', 'eve'])
    // Ende: ein policy.change, dessen Vorgänger beide Zweige enthalten.
    const join = await a.make({ kind: 'policy', policy: admins('alice', 'bob', 'carol') }, [key.alice])
    a.add(join)
    expect(a.forked()).toBe(false)
    expect(a.isValid(join.id)).toBe(true)
    a.add(await a.make({ kind: 'remove', subject: 'dave' }, [key.carol]))
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'eve'])
  })

  it('policy.change neben Entfernung: Fork, die Entfernung verfällt', async () => {
    const a = await setup()
    const heads = a.heads()
    const pa = await on(a, heads).make({ kind: 'policy', policy: { ...admins('alice', 'bob'), 'member.remove': { type: 'threshold', k: 2 } } }, [key.alice])
    const rm = await on(a, heads).make({ kind: 'remove', subject: 'carol' }, [key.bob])
    a.add(pa)
    a.add(rm)
    expect(a.forked()).toBe(true)
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave'])
    const b = clone(a.ops())
    expect(b.forked()).toBe(true)
    expect(names(b.members())).toEqual(names(a.members()))
  })

  it('eine Entfernung des Autors nimmt dem policy.change die Autorität: kein Fork (Strong Removal vor Klassenregel 3)', async () => {
    const a = await setup()
    const heads = a.heads()
    a.add(await on(a, heads).make({ kind: 'remove', subject: 'bob' }, [key.alice]))
    a.add(await on(a, heads).make({ kind: 'policy', policy: admins('bob') }, [key.bob]))
    expect(a.forked()).toBe(false)
    expect(names(a.members())).toEqual(['alice', 'carol', 'dave'])
  })

  it('policyVersion steigt mit jedem wirksamen policy.change um 1', async () => {
    const a = await setup()
    expect(a.policyVersion()).toBe(2)
    a.add(await a.make({ kind: 'policy', policy: admins('alice') }, [key.bob]))
    expect(a.policyVersion()).toBe(3)
    a.add(await a.make({ kind: 'policy', policy: admins('alice') }, [key.carol])) // nicht autorisiert
    expect(a.policyVersion()).toBe(3)
  })
})
