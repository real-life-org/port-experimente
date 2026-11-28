// One complete positive vector: outer link, Request Object, the service's
// log, the derivation of the person's keys, the person's log, the ID token,
// and the POST. Fixed seeds and a fixed time, so every byte is the same on
// every run (Ed25519 signatures are deterministic). `buildVector` writes it,
// `checkVector` runs a given vector through the wallet's and the service's
// checks without a network.

import { fromB64u, platformSubtle } from 'rltp-lib'
import { fromJsonl, multikey, toJsonl, type Entry } from '../kennung-log/log'
import { vh } from '../kennung-log/profiles'
import { keyContext, PROFILE } from './profile'
import { Service, serviceLog, ServiceKeys } from './service'
import { deriveKey, MemoryStorage, Wallet } from './wallet'

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)))
const td = new TextDecoder()
const part = (jwt: string, i: number): Record<string, unknown> => JSON.parse(td.decode(fromB64u(jwt.split('.')[i] as string)))

export const VECTOR_INPUTS = {
  time: '2026-11-28T12:00:00Z',
  service: { host: 'dienst.example', seed: hex(new Uint8Array(32).fill(0x51)), log_time: '2026-11-27T12:00:00Z', name: 'Beispieldienst' },
  person: { secret: hex(new Uint8Array(32).fill(0x70)) },
  nonce: 'bm9uY2UtdmVrdG9yLTAx',
  state: 'c3RhdGUtdmVrdG9yLTAx',
  request_id: 'YW5mcmFnZS12ZWt0b3ItMDE',
}
type Inputs = typeof VECTOR_INPUTS

async function parts (i: Inputs) {
  const now = Date.parse(i.time)
  const keys = new ServiceKeys(unhex(i.service.seed))
  const service = await Service.create({
    host: i.service.host, keys, now: () => now, name: i.service.name,
    log: await serviceLog(i.service.host, keys, i.service.log_time),
    fixed: { nonce: i.nonce, state: i.state, requestId: i.request_id },
  })
  const wallet = new Wallet(unhex(i.person.secret), { now: () => now, storage: new MemoryStorage(), profile: vh })
  return { now, service, wallet }
}

/** Build the vector from its inputs. */
export async function buildVector (i: Inputs = VECTOR_INPUTS) {
  const { service, wallet } = await parts(i)
  const started = await service.start('browser-1', 'cross-device')
  const jwt = service.requestObject(i.request_id) as string
  const logText = service.didLog()
  const opened = await wallet.evaluate(started.link, async (url) => ({ text: url.endsWith('/did.jsonl') ? logText : jwt }))
  if (!opened.ok) throw new Error(opened.reason)
  const answer = await wallet.prepare(opened.request)
  const scid = opened.request.scid
  const derivation = []
  for (const [role, index] of [['update', 0], ['update', 1], ['auth', 0]] as const) {
    const k = await deriveKey(unhex(i.person.secret), { method: 'did:webvh', scid }, role, index)
    derivation.push({ role, index, hkdf_info: keyContext('did:webvh', scid, role, index), public_key_multibase: multikey(k.pubRaw) })
  }
  const body = new URLSearchParams(answer.form).toString()
  const reply = await service.receive(new URLSearchParams(body))
  return {
    profile: PROFILE,
    description: 'One login over two devices: the request the QR code carries, what the wallet fetches and checks, and what it posts. Times in UTC; JWS compact serialisation; logs in JSON Lines.',
    inputs: i,
    derivation_rule: 'seed = HKDF-SHA-256(ikm = person.secret, salt = empty, info = UTF-8 of hkdf_info, 32 bytes); key = Ed25519 from seed (RFC 8032)',
    service_did: service.did,
    service_scid: scid,
    service_log_url: 'https://dienst.example/.well-known/did.jsonl',
    service_log: logText,
    outer_link: started.link,
    request_uri: started.requestUri,
    request_object: { compact: jwt, header: part(jwt, 0), payload: part(jwt, 1) },
    derivation,
    person_did: (wallet.identity(scid) as { did: string }).did,
    person_log: answer.form.did_log as string,
    id_token: { compact: answer.form.id_token as string, header: part(answer.form.id_token as string, 0), payload: part(answer.form.id_token as string, 1) },
    post: { url: answer.url, content_type: 'application/x-www-form-urlencoded', body },
    service_reply: reply,
  }
}
export type Vector = Awaited<ReturnType<typeof buildVector>>

/**
 * Check a vector against the code, from its texts alone: the wallet accepts
 * the outer link with the given log and Request Object; the signatures of
 * Request Object and ID token verify under the logs' keys; the derived keys
 * are the ones in the person's log; the service admits the given POST.
 */
export async function checkVector (v: Vector): Promise<string[]> {
  const problems: string[] = []
  const { service, wallet } = await parts(v.inputs)
  const opened = await wallet.evaluate(v.outer_link, async (url) => url === v.service_log_url ? { text: v.service_log } : url === v.request_uri ? { text: v.request_object.compact } : { error: 'unexpected fetch ' + url })
  if (!opened.ok) problems.push(`wallet refuses: ${opened.reason}`)
  const personLog = fromJsonl(v.person_log as string) as Entry[] | null
  if (!personLog) { problems.push('person log is not JSON Lines'); return problems }
  const first = personLog[0] as Entry
  const keys = Object.fromEntries(v.derivation.map((d) => [`${d.role}${d.index}`, d.public_key_multibase]))
  for (const d of v.derivation) {
    const k = await deriveKey(unhex(v.inputs.person.secret), { method: 'did:webvh', scid: v.service_scid }, d.role, d.index)
    if (multikey(k.pubRaw) !== d.public_key_multibase) problems.push(`derived ${d.role} ${d.index} differs`)
  }
  if ((first.parameters.updateKeys as string[])[0] !== keys.update0) problems.push('update key 0 is not the derived one')
  if ((first.state.verificationMethod as { publicKeyMultibase: string }[])[0]?.publicKeyMultibase !== keys.auth0) problems.push('auth key 0 is not the derived one')
  if (toJsonl(personLog) !== v.person_log) problems.push('person log is not in canonical JSON Lines')
  // the service starts the same request (fixed values), then takes the POST
  await service.start('browser-1', 'cross-device')
  const reply = await service.receive(new URLSearchParams(v.post.body))
  if (reply.status !== 200) problems.push(`service refuses: ${JSON.stringify(reply.body)}`)
  // the ID token's signature, by hand: Ed25519 over header.payload with the derived auth key 0
  const [h, p, s] = v.id_token.compact.split('.') as [string, string, string]
  const raw = await deriveKey(unhex(v.inputs.person.secret), { method: 'did:webvh', scid: v.service_scid }, 'auth', 0)
  const pub = await platformSubtle().importKey('raw', raw.pubRaw as BufferSource, { name: 'Ed25519' }, false, ['verify'])
  if (!await platformSubtle().verify('Ed25519', pub, fromB64u(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`))) problems.push('id token signature')
  return problems
}
