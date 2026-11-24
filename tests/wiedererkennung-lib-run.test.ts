import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { runOnLibrary, type LibRun } from '../src/lab/wiedererkennung/lib-run'
import expected from '../src/lab/wiedererkennung/lib-run.expected.json'
import type { Trace } from '../src/lab/wiedererkennung/traces'

// The traces of the rule, run against the published library. A measurement,
// pinned so that a new library version shows what moved: which traces it
// can run at all, which steps it does not follow, and whether it ends where
// the rule ends. Not a requirement on the library.
test('the traces against the library: what it follows and where it ends', async () => {
  const dir = new URL('../src/lab/wiedererkennung/traces/', import.meta.url)
  const got: Record<string, LibRun> = {}
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const t = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Trace
    got[t.name] = await runOnLibrary(t)
  }
  expect(got).toEqual(expected)
}, 120_000)
