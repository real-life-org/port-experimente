import { describe, expect, test } from 'vitest'
import { rule, Sync, type Step } from '../src/lab/alltag/core'

/* eslint-disable @typescript-eslint/no-explicit-any */

// The core without the library: a toy cut whose only entry is an answer to a subject.
// `fate` says what applying it does on the acting device: it works, the "library" refuses it, or the step breaks off.
type Body = { kind: 'answer', subject: string, choice: 'accept' | 'decline' }
class Toy extends Sync<Body> {
  fate: 'works' | 'refused' | 'breaks' = 'works'
  ran: string[] = []
  constructor (name: string) { super(name, {} as any) }
  answer (subject: string, choice: 'accept' | 'decline'): Promise<any> { this.write({ kind: 'answer', subject, choice }, false); return this.applyOpen(0) }
  holds (subject: string): ReturnType<typeof rule<string>> {
    const all = this.effective(this.of('answer').filter((e) => e.body.subject === subject))
    const accepts = all.filter((e) => e.body.choice === 'accept').map((e) => e.id)
    return rule({ handed: this.handed(subject).filter((c) => accepts.includes(c)), declined: all.some((e) => e.body.choice === 'decline'), first: accepts[0] })
  }
  doc = (id: string): any => ({ digest: 'doc-of-' + id })
  protected subjectOf (b: Body): string { return b.subject }
  declining (subject: string): boolean { return this.running(this.of('answer').filter((e) => e.body.subject === subject)).some((e) => e.body.choice === 'decline') }
  protected mayLeave (subject: string, cause: string): boolean {
    const v = this.holds(subject)
    return typeof v !== 'string' && v.accepts.includes(cause) && (this.handed(subject).includes(cause) || !this.declining(subject))
  }
  protected async apply (e: { id: string, body: Body }, own: boolean): Promise<Step> {
    if (!own) return
    if (this.fate === 'breaks') throw new Error('crash')
    if (this.fate === 'refused') { this.refuse(e, 'no'); return }
    this.ran.push(e.id)
    if (e.body.choice === 'accept') this.leaves(e.id, e.body.subject, [this.doc(e.id)])
    return { outbound: e.body.choice === 'accept' ? [this.doc(e.id)] : [] }
  }
}
const kinds = (D: Toy): string[] => [...D.entries.values()].map((e) => `${e.id} ${e.body.kind}`)

describe('the rule between two answers of one person', () => {
  test('a confirmed accept stands; else every accept that left; else a decline; else the first accept; else nothing', () => {
    expect(rule({ confirmed: 'a', handed: ['b'], declined: true, first: 'c' })).toEqual({ accepts: ['a'] })
    expect(rule({ handed: ['b', 'c'], declined: true, first: 'c' })).toEqual({ accepts: ['b', 'c'] })
    expect(rule({ handed: [], declined: true, first: 'c' })).toBe('declined')
    expect(rule({ handed: [], declined: false, first: 'c' })).toEqual({ accepts: ['c'] })
    expect(rule({ handed: [], declined: false })).toBe('open')
  })
})

describe('applying entries', () => {
  test('a break leaves the entry open and holds up what follows; the next call applies both', async () => {
    const T = new Toy('phone')
    T.fate = 'breaks'
    expect((await T.answer('s', 'accept')).stoppedAt).toBe('phone#1: crash')
    expect((await T.answer('t', 'accept')).stoppedAt).toBe('phone#1: crash')
    T.fate = 'works'
    expect(await T.syncFrom(T)).toEqual({ outbound: [T.doc('phone#1'), T.doc('phone#2')], stoppedAt: null })
    expect(T.ran).toEqual(['phone#1', 'phone#2'])
    // applied once: a further call does nothing
    expect((await T.syncFrom(T)).outbound).toEqual([])
  })

  test('a refusal closes the entry, is noted in the log, and what follows runs', async () => {
    const T = new Toy('phone')
    T.fate = 'refused'
    expect((await T.answer('s', 'decline')).stoppedAt).toBe(null)
    T.fate = 'works'
    expect((await T.answer('t', 'accept')).stoppedAt).toBe(null)
    expect(kinds(T)).toEqual(['phone#1 answer', 'phone#2 void', 'phone#3 answer', 'phone#4 took'])
    expect({ refused: T.refused, ran: T.ran, voided: T.voided('phone#1') }).toEqual({ refused: ['phone#1: no'], ran: ['phone#3'], voided: true })
  })
})

describe('what took effect, and the door', () => {
  test('a refused decline counts nowhere: on the sister the accept stands and leaves', async () => {
    const T = new Toy('phone'), L = new Toy('laptop')
    const out = (await T.answer('s', 'accept')).outbound
    L.fate = 'refused'
    await L.answer('s', 'decline')
    expect(L.holds('s')).toBe('open')
    await T.syncFrom(L)
    expect(T.holds('s')).toEqual({ accepts: ['phone#1'] })
    expect(T.toCarrier(out)).toEqual(out)
    expect(kinds(T)).toEqual(['phone#1 answer', 'phone#2 took', 'laptop#1 answer', 'laptop#2 void', 'phone#3 handed'])
  })

  test('the rule is asked at the door: a decline learned before the first handover keeps the accept in the house, even when applying it broke off', async () => {
    const T = new Toy('phone'), L = new Toy('laptop')
    const out = (await T.answer('s', 'accept')).outbound
    await L.answer('s', 'decline')
    // the phone learns the decline; nothing was "settled" for it
    await T.syncFrom(L)
    expect(T.holds('s')).toBe('declined')
    expect(T.toCarrier(out)).toEqual([])
    expect(kinds(T).some((k) => k.endsWith('handed'))).toBe(false)
    // and it stays in the house on every later try
    expect(T.toCarrier(out)).toEqual([])
  })

  test('an accept that left stands against a later decline, and leaves again without a second note', async () => {
    const T = new Toy('phone'), L = new Toy('laptop')
    const out = (await T.answer('s', 'accept')).outbound
    expect(T.toCarrier(out)).toEqual(out)
    await L.answer('s', 'decline')
    await T.syncFrom(L); await L.syncFrom(T)
    expect([T.holds('s'), L.holds('s')]).toEqual([{ accepts: ['phone#1'] }, { accepts: ['phone#1'] }])
    expect(T.toCarrier(out)).toEqual(out)                    // a repeat by the library
    expect(kinds(T).filter((k) => k.endsWith('handed'))).toHaveLength(1)
  })

  test('two accepts apart, the devices hear of each other before either leaves: one leaves', async () => {
    const T = new Toy('phone'), L = new Toy('laptop')
    const [a, b] = [(await T.answer('s', 'accept')).outbound, (await L.answer('s', 'accept')).outbound]
    await T.syncFrom(L); await L.syncFrom(T)
    expect([T.toCarrier(a), L.toCarrier(b)]).toEqual([[], b])   // the first by entry id: the laptop's
  })

test('three facts, each its own entry: chosen, took effect, handed', async () => {
    const T = new Toy('phone')
    const out = (await T.answer('s', 'accept')).outbound
    T.toCarrier(out)
    expect(kinds(T)).toEqual(['phone#1 answer', 'phone#2 took', 'phone#3 handed'])
  })

  // What a sync brought that broke off after entry `id`.
  const upTo = (D: Toy, id: string): { entries: Toy['entries'] } => { const all = [...D.entries]; return { entries: new Map(all.slice(0, all.findIndex(([x]) => x === id) + 1)) } }

  test('a running decline is not a decline: it counts nowhere, a competing accept only waits, and a later void lifts the wait', async () => {
    const T = new Toy('phone'), L = new Toy('laptop')
    const out = (await T.answer('s', 'accept')).outbound
    L.fate = 'refused'
    await L.answer('s', 'decline')
    await T.syncFrom(upTo(L, 'laptop#1'))                    // the choice, not yet what became of it
    expect({ holds: T.holds('s'), declining: T.declining('s'), leaves: T.toCarrier(out) }).toEqual({ holds: { accepts: ['phone#1'] }, declining: true, leaves: [] })
    await T.syncFrom(L)                                      // the library refused it
    expect({ holds: T.holds('s'), declining: T.declining('s'), leaves: T.toCarrier(out) }).toEqual({ holds: { accepts: ['phone#1'] }, declining: false, leaves: out })
  })

  test('the same after two rounds as after one, for a decline that took effect and for one that was refused', async () => {
    const run = async (rounds: 1 | 2, fate: 'works' | 'refused'): Promise<unknown> => {
      const T = new Toy('phone'), L = new Toy('laptop')
      const out = (await T.answer('s', 'accept')).outbound
      L.fate = fate
      await L.answer('s', 'decline')
      if (rounds === 2) { await T.syncFrom(upTo(L, 'laptop#1')); T.toCarrier(out) }
      await T.syncFrom(L)
      return { holds: T.holds('s'), declining: T.declining('s'), leaves: T.toCarrier(out).length }
    }
    expect(await run(2, 'refused')).toEqual(await run(1, 'refused'))
    expect(await run(2, 'works')).toEqual(await run(1, 'works'))
    expect(await run(2, 'refused')).toEqual({ holds: { accepts: ['phone#1'] }, declining: false, leaves: 1 })
    expect(await run(2, 'works')).toEqual({ holds: 'declined', declining: false, leaves: 0 })
  })

  test('a handover stays binding: an accept that left stands against a decline that is running or took effect', async () => {
    const T = new Toy('phone'), L = new Toy('laptop')
    const out = (await T.answer('s', 'accept')).outbound
    expect(T.toCarrier(out)).toEqual(out)
    await L.answer('s', 'decline')
    await T.syncFrom(upTo(L, 'laptop#1'))
    expect(T.toCarrier(out)).toEqual(out)                    // running decline: the accept already left
    await T.syncFrom(L)
    expect({ holds: T.holds('s'), leaves: T.toCarrier(out) }).toEqual({ holds: { accepts: ['phone#1'] }, leaves: out })
  })

  test('a break between the library and bringing the device in line: the next call completes the same act, with one note', async () => {
    class Breaking extends Toy {
      broke = false
      protected async settle (): Promise<void> { if (!this.broke) { this.broke = true; throw new Error('crash') } }
    }
    const T = new Breaking('phone')
    expect((await T.answer('s', 'accept')).stoppedAt).toBe('phone#1: crash')
    expect((await T.syncFrom(T)).stoppedAt).toBe(null)
    expect(kinds(T)).toEqual(['phone#1 answer', 'phone#2 took'])
  })

    test('the accept of a refused act never leaves', async () => {
    const T = new Toy('phone')
    const out = (await T.answer('s', 'accept')).outbound
    ;(T as any).write({ kind: 'void', cause: 'phone#1', code: 'late' }, true)
    expect(T.toCarrier(out)).toEqual([])
  })
})
