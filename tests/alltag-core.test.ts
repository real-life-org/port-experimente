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
  protected mayLeave (subject: string, cause: string): boolean { const v = this.holds(subject); return typeof v !== 'string' && v.accepts.includes(cause) }
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
    expect(kinds(T)).toEqual(['phone#1 answer', 'phone#2 void', 'phone#3 answer'])
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
    expect(kinds(T)).toContain('phone#2 handed')
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

  test('the accept of a refused act never leaves', async () => {
    const T = new Toy('phone')
    const out = (await T.answer('s', 'accept')).outbound
    ;(T as any).write({ kind: 'void', cause: 'phone#1', code: 'late' }, true)
    expect(T.toCarrier(out)).toEqual([])
  })
})
