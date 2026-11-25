import { expect, test } from 'vitest'
import { persistentRoot, STORE_KEY, type KeyValueStore } from '../src/lab/anmeldung/wallet-store'
import { loginKey } from '../src/lab/anmeldung/wallet'
import { anchorOfEd } from 'rltp-lib'

// Finding #135: with blocked storage the demo wallet fell back to a random
// key and silently switched accounts. Now it refuses before signing.

let counter = 0
const random = (n: number): Uint8Array => new Uint8Array(n).fill(++counter)
const memory = (): KeyValueStore => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) } } }
const didAt = async (root: Uint8Array) => anchorOfEd((await loginKey(root, 'https://beispiel.org')).pubRaw)

test('mit Speicher: zweimal dieselbe Identität, also dasselbe Konto', async () => {
  const s = memory()
  const a = persistentRoot(() => s, random), b = persistentRoot(() => s, random)
  expect(a.ok && a.created).toBe(true)
  expect(b.ok && !b.created).toBe(true)
  expect(await didAt((a as any).root)).toBe(await didAt((b as any).root))
})

test('Speicherzugriff wirft (gesperrt): keine Identität, kein Ausweichen auf Zufall', () => {
  const r = persistentRoot(() => { throw new Error('SecurityError') }, random)
  expect(r.ok).toBe(false)
  const throwing: KeyValueStore = { getItem: () => { throw new Error('SecurityError') }, setItem: () => {} }
  expect(persistentRoot(() => throwing, random).ok).toBe(false)
})

test('Schreiben schlägt fehl oder speichert still nichts: keine Identität', () => {
  const refuses: KeyValueStore = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } }
  expect(persistentRoot(() => refuses, random).ok).toBe(false)
  const forgets: KeyValueStore = { getItem: () => null, setItem: () => {} }
  const r = persistentRoot(() => forgets, random)
  expect(r).toEqual({ ok: false, reason: expect.stringContaining('neues Konto') })
})

test('beschädigte gespeicherte Identität wird nicht still ersetzt', () => {
  const broken: KeyValueStore = { getItem: (k) => (k === STORE_KEY ? 'kurz' : null), setItem: () => {} }
  expect(persistentRoot(() => broken, random)).toEqual({ ok: false, reason: 'Die gespeicherte Identität ist beschädigt.' })
})
