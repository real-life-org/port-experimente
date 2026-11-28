import { expect, test } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { buildVector, checkVector, type Vector } from '../src/lab/anmeldung-log/vector'

// The positive vector: built from fixed inputs, pinned in vector.json, and
// checked from its texts alone. WRITE_VECTOR=1 writes the file anew.

const FILE = new URL('../src/lab/anmeldung-log/vector.json', import.meta.url)

test('the vector is what the code builds from its inputs', async () => {
  const v = await buildVector()
  if (process.env.WRITE_VECTOR === '1') writeFileSync(FILE, JSON.stringify(v, null, 2) + '\n')
  expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(JSON.parse(JSON.stringify(v)))
  expect(v.service_reply).toEqual({ status: 200, body: {} })
})

test('the pinned vector passes the wallet and the service, from its texts alone', async () => {
  const v = JSON.parse(readFileSync(FILE, 'utf8')) as Vector
  expect(await checkVector(v)).toEqual([])
})

test('a vector with one changed byte in the ID token or the request object is refused', async () => {
  const v = JSON.parse(readFileSync(FILE, 'utf8')) as Vector
  const flip = (s: string) => s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1)
  const badRequest = { ...v, request_object: { ...v.request_object, compact: flip(v.request_object.compact) } }
  expect((await checkVector(badRequest))[0]).toMatch(/^wallet refuses: request: signature does not verify/)
  const form = new URLSearchParams(v.post.body); form.set('id_token', flip(form.get('id_token')!))
  expect((await checkVector({ ...v, post: { ...v.post, body: form.toString() } })).some((p) => p.startsWith('service refuses'))).toBe(true)
})

test('checkVector notices what is missing or does not match: each change to a copy of the vector is an error', async () => {
  const v = JSON.parse(readFileSync(FILE, 'utf8')) as Vector
  const copy = (): Vector => structuredClone(v)
  const changes: [string, (c: Vector) => void, RegExp][] = [
    ['both update/1 rows removed', (c) => {
      c.service_derivation = c.service_derivation.filter((d) => !(d.role === 'update' && d.index === 1))
      c.derivation = c.derivation.filter((d) => !(d.role === 'update' && d.index === 1))
    }, /^service_derivation: the rows are not exactly/],
    ['the person\'s auth/0 row removed', (c) => { c.derivation = c.derivation.filter((d) => d.role !== 'auth') }, /^derivation: the rows are not exactly/],
    ['a row given twice', (c) => { c.derivation = [...c.derivation, c.derivation[0]!] }, /^derivation: the rows are not exactly/],
    ['the POST media type', (c) => { c.post.content_type = 'text/plain' as never }, /^post: content_type/],
    ['the service name in the inputs', (c) => { c.inputs.service.name = 'Anderer Dienst' }, /^request_object: client_name is not inputs.service.name/],
    ['the service host in the inputs', (c) => { c.inputs.service.host = 'anderer.example' }, /^service_did does not name inputs.service.host/],
    ['the time in the inputs', (c) => { c.inputs.time = '2026-11-28T12:00:01Z' }, /^request_object: iat is not inputs.time/],
    ['the service log time in the inputs', (c) => { c.inputs.service.log_time = '2026-11-27T12:00:01Z' }, /^service log: versionTime/],
    ['the request id in the inputs', (c) => { c.inputs.request_id = 'b3RoZXI' }, /^request_uri is not the service origin/],
    ['the person\'s genesis commitment', (c) => {
      const log = c.person_log.split('\n')
      const e = JSON.parse(log[0]!); e.parameters.nextKeyHashes = ['QmUnrelatedUnrelatedUnrelatedUnrelatedUnrelated1']; log[0] = JSON.stringify(e)
      c.person_log = log.join('\n')
    }, /^person log: nextKeyHashes is not the hash of the derived update key 1/],
    ['a seed with one hex digit more', (c) => { c.inputs.service.seed += 'a' }, /^inputs.service.seed is not 64 hex digits/],
    ['a secret with a character that is no hex digit', (c) => { c.inputs.person.secret = 'z' + c.inputs.person.secret.slice(1) }, /^inputs.person.secret is not 64 hex digits/],
    ['another profile', (c) => { c.profile = 'x-other/1' as never }, /^profile is not x-anmeldung-log\/1/],
    ['another derivation rule', (c) => { c.derivation_rule = c.derivation_rule.replace('SHA-256', 'SHA-512') }, /^derivation_rule is not the rule of this code/],
    ['a service log whose first entry is null', (c) => { c.service_log = 'null\n' }, /^service log: the first entry is not a log entry/],
    ['a person log whose first entry is null', (c) => { c.person_log = 'null\n' }, /^person log: the first entry is not a log entry/],
    ['a service log whose first entry is an array', (c) => { c.service_log = '[]\n' }, /^service log: the first entry is not a log entry/],
    ['the service\'s genesis commitment', (c) => {
      const log = c.service_log.split('\n')
      const e = JSON.parse(log[0]!); e.parameters.nextKeyHashes = ['QmUnrelatedUnrelatedUnrelatedUnrelatedUnrelated1']; log[0] = JSON.stringify(e)
      c.service_log = log.join('\n')
    }, /^service log: nextKeyHashes is not the hash of the derived update key 1/],
  ]
  for (const [name, change, want] of changes) {
    const c = copy()
    change(c)
    const problems = await checkVector(c)
    expect([name, problems.some((p) => want.test(p))], JSON.stringify(problems)).toEqual([name, true])
  }
})

test('the vector keeps the body the wallet posted, byte for byte, and gives it to the service as it is', async () => {
  // a line that adds a second state after the wallet's: the body stays as posted, and the service takes the first value
  const v = await buildVector(undefined, { line: (body) => body + '&state=other' })
  expect(v.post.body.endsWith('&state=other')).toBe(true)
  expect(new URLSearchParams(v.post.body).getAll('state')).toEqual([v.inputs.state, 'other'])
  expect(v.service_reply).toEqual({ status: 200, body: {} })
})
