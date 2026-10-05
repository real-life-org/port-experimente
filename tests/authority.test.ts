import { describe, expect, it } from 'vitest'
import { AuthorityLog, type AuthOp } from '../src/candidates/rltp-beekem/authority'

/** Zwei Logs, die denselben DAG kennen, müssen dieselbe Mitgliedschaft liefern. */
async function setup() {
  const a = new AuthorityLog()
  const create = await a.make('create', 'alice', 'alice')
  a.add(create)
  a.add(await a.make('add', 'alice', 'bob', 'admin'))
  a.add(await a.make('add', 'alice', 'carol', 'member'))
  a.add(await a.make('add', 'alice', 'dave', 'member'))
  return a
}
const clone = (from: AuthorityLog, ops: AuthOp[]) => {
  const b = new AuthorityLog()
  // Reihenfolge der Zustellung darf keine Rolle spielen: rückwärts, mit Warteschleife.
  let pending = [...ops].reverse()
  while (pending.length) {
    const rest: AuthOp[] = []
    for (const op of pending) if (b.add(op) === 'wartet') rest.push(op)
    if (rest.length === pending.length) throw new Error('Vorgänger fehlen dauerhaft')
    pending = rest
  }
  void from
  return b
}
const names = (m: Map<string, string>) => [...m.keys()].sort()

describe('Autoritätslog nach der Konfliktmatrix', () => {
  it('Nicht-Admin darf nicht aufnehmen', async () => {
    const a = await setup()
    a.add(await a.make('add', 'carol', 'eve', 'member'))
    expect(names(a.members())).toEqual(['alice', 'bob', 'carol', 'dave'])
  })

  it('zwei gleichzeitige Entfernungen verschiedener Personen gelten beide', async () => {
    const a = await setup()
    const heads = a.heads()
    const rmCarol = { ...(await a.make('remove', 'alice', 'carol')), preds: heads }
    const rmDave = { ...(await a.make('remove', 'bob', 'dave')), preds: heads }
    a.add(rmCarol)
    a.add(rmDave)
    expect(names(a.members())).toEqual(['alice', 'bob'])
  })

  it('gegenseitige Entfernung: beide raus', async () => {
    const a = await setup()
    const heads = a.heads()
    a.add({ ...(await a.make('remove', 'alice', 'bob')), preds: heads })
    a.add({ ...(await a.make('remove', 'bob', 'alice')), preds: heads })
    expect(names(a.members())).toEqual(['carol', 'dave'])
  })

  it('Strong Removal: Aufnahme durch gleichzeitig Entfernten ist ungültig, transitiv', async () => {
    const a = await setup()
    const heads = a.heads()
    const rmBob = { ...(await a.make('remove', 'alice', 'bob')), preds: heads }
    const addX = { ...(await a.make('add', 'bob', 'x', 'admin')), preds: heads }
    a.add(rmBob)
    a.add(addX)
    const addY = await a.make('add', 'x', 'y', 'member') // x glaubt, Admin zu sein
    a.add(addY)
    expect(names(a.members())).toEqual(['alice', 'carol', 'dave'])
    expect(a.isValid(addX.id)).toBe(false)
    expect(a.isValid(addY.id)).toBe(false)
  })

  it('Gründerin ohne Sonderrolle: ein anderer Admin kann sie entfernen', async () => {
    const a = await setup()
    a.add(await a.make('remove', 'bob', 'alice'))
    expect(names(a.members())).toEqual(['bob', 'carol', 'dave'])
    a.add(await a.make('remove', 'bob', 'dave'))
    expect(names(a.members())).toEqual(['bob', 'carol'])
  })

  it('Zustellreihenfolge ändert das Ergebnis nicht', async () => {
    const a = await setup()
    const heads = a.heads()
    const ops: AuthOp[] = []
    const rmBob = { ...(await a.make('remove', 'alice', 'bob')), preds: heads }
    const addX = { ...(await a.make('add', 'bob', 'x', 'admin')), preds: heads }
    a.add(rmBob)
    a.add(addX)
    for (const id of [...(a as unknown as { ops: Map<string, AuthOp> }).ops.keys()]) ops.push((a as unknown as { ops: Map<string, AuthOp> }).ops.get(id)!)
    const b = clone(a, ops)
    expect(names(b.members())).toEqual(names(a.members()))
    expect(b.heads()).toEqual(a.heads())
  })
})
