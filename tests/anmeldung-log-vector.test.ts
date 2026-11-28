import { expect, test } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { buildVector, checkVector, type Vector } from '../src/lab/anmeldung-log/vector'

// The positive vector: built from fixed inputs, pinned in vector.json, and
// checked from its texts alone. WRITE_VECTOR=1 writes the file anew.

const FILE = new URL('../src/lab/anmeldung-log/vector.json', import.meta.url)

test('the vector is what the code builds from its inputs', async () => {
  const v = await buildVector()
  if (process.env.WRITE_VECTOR) writeFileSync(FILE, JSON.stringify(v, null, 2) + '\n')
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
