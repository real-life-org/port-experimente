import { describe, expect, it } from 'vitest'
import { runScenario, scenarios } from '../src/lab/scenarios'
import { runLoad } from '../src/lab/load'
import { klartext } from '../src/candidates/klartext'
import type { Candidate } from '../src/lab/types'

/** Klartext mit eigenem Transport-Stub, der Online-Wechsel und Aufräumen mitschreibt. */
function recording(opts: { failOn?: 'createGroup' } = {}) {
  const log: string[] = []
  let disposed = 0
  const inner = klartext()
  const texts = new Map<string, string[]>()
  const candidate: Candidate = {
    ...inner,
    async createGroup(d) {
      if (opts.failOn === 'createGroup') throw new Error('eingebauter Fehler')
      return inner.createGroup(d)
    },
    transport: {
      async setOnline(d, online) { log.push(`${d}:${online ? 'online' : 'offline'}`) },
      async settle() {},
      async write(d, text) { log.push(`${d}:schreibt ${text}`); texts.set(d, [...(texts.get(d) ?? []), text]) },
      read: (d) => texts.get(d) ?? [],
      idleMs: () => 0,
    },
    async dispose() { disposed++ },
  }
  return { candidate, log, disposed: () => disposed }
}

describe('Prüfstand mit eigenem Transport', () => {
  it('S3 schaltet Bob offline, während er schreibt, und danach wieder online', async () => {
    const rec = recording()
    await runScenario(() => rec.candidate, scenarios.find((s) => s.id === 'S3')!)
    const i = rec.log.indexOf('bob:offline')
    expect(i, rec.log.join(' ')).toBeGreaterThanOrEqual(0)
    expect(rec.log.indexOf('bob:schreibt offline-bob')).toBeGreaterThan(i)
    expect(rec.log.indexOf('bob:online')).toBeGreaterThan(rec.log.indexOf('bob:schreibt offline-bob'))
    expect(rec.log).not.toContain('alice:offline')
  })

  it('S9 räumt den Kandidaten auch nach einem Fehler auf und behält den Fehler', async () => {
    const rec = recording({ failOn: 'createGroup' })
    const r = await runLoad(() => rec.candidate, 3, 5)
    expect(r.error).toBe('eingebauter Fehler')
    expect(rec.disposed()).toBe(1)
  })
})
