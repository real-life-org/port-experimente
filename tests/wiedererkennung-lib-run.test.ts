import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { runOnLibrary, type Ceremony, type LibRun } from '../src/lab/wiedererkennung/lib-run'
import expected from '../src/lab/wiedererkennung/lib-run.expected.json'
import type { Trace } from '../src/lab/wiedererkennung/traces'

// The traces of the rule, run against the published library. A measurement,
// pinned so that a new library version shows what moved: which traces it
// can run at all, which steps it does not follow, and whether it ends where
// the rule ends. Under both ceremonies: shared-connect, which the app uses,
// and encounter-scan. Not a requirement on the library.
test.each(['shared-connect', 'encounter-scan'] as Ceremony[])('the traces against the library under %s: what it follows and where it ends', async (ceremony) => {
  const dir = new URL('../src/lab/wiedererkennung/traces/', import.meta.url)
  const got: Record<string, LibRun> = {}
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const t = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Trace
    got[t.name] = await runOnLibrary(t, ceremony)
  }
  expect(got).toEqual((expected as Record<string, unknown>)[ceremony])
}, 120_000)

const read = (name: string): Trace => JSON.parse(readFileSync(new URL(`../src/lab/wiedererkennung/traces/${name}.json`, import.meta.url), 'utf8')) as Trace

// "Follows every step" is checked at the step: the receiver's contacts fall
// from two to one when it is handed the mapping, not somewhere before the end.
test('met-again: each mapping takes effect in the library at its own step', async () => {
  const t = read('met-again'), r = await runOnLibrary(t)
  const at = (n: number): string => (r.afterStep.find((x) => x.step === n) as { library: string }).library
  const mappings = t.steps.map((s, i) => ('fetchMapping' in s ? i + 1 : 0)).filter(Boolean)
  expect(mappings).toEqual([10, 12])
  expect([at(9), at(10), at(12)]).toEqual(['2/2', '1/2', '1/1'])
  expect(r.differsAt).toEqual([])
}, 120_000)

// Whether a trace can run depends on how many devices of a person act, not on what they are called.
test('a trace in which a person acts on its second device only runs like the same trace on its first', async () => {
  const t = read('met-again')
  const swap = (d: string): string => (d === 'a1' ? 'a2' : d === 'a2' ? 'a1' : d)
  const swapped = JSON.parse(JSON.stringify(t)) as Trace
  for (const s of swapped.steps as unknown as Array<Record<string, string>>) for (const k of ['on', 'sync', 'to']) if (k in s) s[k] = swap(s[k] as string)
  const c = swapped.expect.relationships; [c.a1, c.a2] = [c.a2, c.a1]
  const r = await runOnLibrary(swapped)
  expect(r.runnable).toBe(true)
  expect({ ...r }).toEqual({ ...(await runOnLibrary(t)) })
}, 120_000)
