// One complete positive vector: outer link, Request Object, the service's
// log and the derivation of its keys, the derivation of the person's keys,
// the person's log, the ID token, and the POST. Fixed seeds and a fixed time,
// so every byte is the same on every run (Ed25519 signatures are
// deterministic). `buildVector` writes it; `checkVector` runs a given vector
// through the wallet's and the service's checks without a network, derives
// every key from the inputs, and compares every field that repeats another.

import { edFromSeed, fromB64u, hkdf, platformSubtle } from 'rltp-lib'
import { fromJsonl, keyHash, multikey, toJsonl, type Entry } from '../kennung-log/log'
import { vh } from '../kennung-log/profiles'
import { kidOf } from '../kennung-log/verifier'
import { CLIENT_ID_PREFIX, DID_LOG_FIELD, keyContext, locate, parseOuter, PROFILE, subjectMethodOf, type KeyFor } from './profile'
import { REQUEST_PATH, Service, serviceKeyInfo, serviceLog, ServiceKeys } from './service'
import type { Transport } from './transport'
import { deriveKey, MemoryStorage, Wallet } from './wallet'

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)))
const td = new TextDecoder(), te = new TextEncoder()
const part = (jwt: string, i: number): Record<string, unknown> => JSON.parse(td.decode(fromB64u(jwt.split('.')[i] as string)))
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export const VECTOR_INPUTS = {
  time: '2026-11-28T12:00:00Z',
  service: { host: 'dienst.example', seed: hex(new Uint8Array(32).fill(0x51)), log_time: '2026-11-27T12:00:00Z', name: 'Beispieldienst' },
  person: { secret: hex(new Uint8Array(32).fill(0x70)) },
  nonce: 'bm9uY2UtdmVrdG9yLTAx',
  state: 'c3RhdGUtdmVrdG9yLTAx',
  request_id: 'YW5mcmFnZS12ZWt0b3ItMDE',
}
type Inputs = typeof VECTOR_INPUTS
const DERIVATION_RULE = 'seed = HKDF-SHA-256(ikm, salt = empty, info = UTF-8 of hkdf_info, 32 bytes); key = Ed25519 from seed (RFC 8032). ikm is service.seed for the service keys, person.secret for the person keys.'

/**
 * The wallet's transport for the vector, without a network: it serves the
 * given texts at the given URLs and keeps what the wallet posts instead of
 * sending it. The wallet runs its whole way, gate included.
 */
function fixedTransport (served: () => Record<string, string>): { transport: Transport, posts: { url: string, body: string }[] } {
  const posts: { url: string, body: string }[] = []
  return {
    posts,
    transport: {
      get: async (url) => { const text = served()[url]; return text === undefined ? { error: 'unexpected fetch ' + url } : { status: 200, type: '', text } },
      post: async (url, body) => { posts.push({ url, body }); return { status: 200, type: 'application/json', text: '{}' } },
    },
  }
}

async function parts (i: Inputs, served: () => Record<string, string>) {
  const now = Date.parse(i.time)
  const keys = new ServiceKeys(unhex(i.service.seed))
  const service = await Service.create({
    host: i.service.host, keys, now: () => now, name: i.service.name,
    log: await serviceLog(i.service.host, keys, i.service.log_time),
    fixed: { nonce: i.nonce, state: i.state, requestId: i.request_id },
  })
  const net = fixedTransport(served)
  const wallet = new Wallet(unhex(i.person.secret), { now: () => now, storage: new MemoryStorage(), profile: vh, transport: net.transport })
  return { now, service, wallet, posts: net.posts }
}

const SERVICE_KEYS = [['update', 0], ['update', 1], ['auth', 0]] as const

/** Build the vector from its inputs. */
export async function buildVector (i: Inputs = VECTOR_INPUTS) {
  const served: Record<string, string> = {}
  const { service, wallet, posts } = await parts(i, () => served)
  const started = await service.start('cross-device')
  const jwt = service.requestObject(i.request_id) as string
  const logText = service.didLog()
  const logUrl = (locate(service.did) as { logUrl: string }).logUrl
  served[logUrl] = logText; served[started.requestUri] = jwt
  const opened = await wallet.open(started.link)
  if (!opened.ok) throw new Error(opened.reason)
  const sent = await wallet.confirm(opened.request)
  if ('error' in sent) throw new Error(sent.error)
  const posted = posts[0] as { url: string, body: string }
  const answer = { url: posted.url, form: Object.fromEntries(new URLSearchParams(posted.body)) as Record<string, string> }
  const scid = opened.request.scid
  const k: KeyFor = { method: 'did:webvh', scid, subjectMethod: subjectMethodOf(vh) }
  const serviceDerivation = []
  for (const [role, index] of SERVICE_KEYS) {
    const key = await (role === 'update' ? new ServiceKeys(unhex(i.service.seed)).update(index) : new ServiceKeys(unhex(i.service.seed)).auth(index))
    serviceDerivation.push({ role, index, hkdf_info: serviceKeyInfo(role, index), public_key_multibase: multikey(key.pubRaw) })
  }
  const derivation = []
  for (const [role, index] of SERVICE_KEYS) {
    const key = await deriveKey(unhex(i.person.secret), k, role, index)
    derivation.push({ role, index, hkdf_info: keyContext(k, role, index), public_key_multibase: multikey(key.pubRaw) })
  }
  const body = new URLSearchParams(answer.form).toString()
  const reply = await service.receive(new URLSearchParams(body))
  return {
    profile: PROFILE,
    description: 'One login over two devices: the request the QR code carries, what the wallet fetches and checks, and what it posts. Times in UTC; JWS compact serialisation; logs in JSON Lines.',
    inputs: i,
    derivation_rule: DERIVATION_RULE,
    service_derivation: serviceDerivation,
    service_did: service.did,
    service_scid: scid,
    service_log_url: logUrl,
    service_log: logText,
    outer_link: started.link,
    request_uri: started.requestUri,
    request_object: { compact: jwt, header: part(jwt, 0), payload: part(jwt, 1) },
    subject_method: k.subjectMethod,
    derivation,
    person_did: (wallet.identity(scid) as { did: string }).did,
    person_log: answer.form.did_log as string,
    id_token: { compact: answer.form.id_token as string, header: part(answer.form.id_token as string, 0), payload: part(answer.form.id_token as string, 1) },
    post: { url: answer.url, content_type: 'application/x-www-form-urlencoded', body },
    service_reply: reply,
  }
}
export type Vector = Awaited<ReturnType<typeof buildVector>>

async function verifies (pubRaw: Uint8Array, jwt: string): Promise<boolean> {
  const [h, p, s] = jwt.split('.') as [string, string, string]
  try {
    const pub = await platformSubtle().importKey('raw', pubRaw as BufferSource, { name: 'Ed25519' }, false, ['verify'])
    return await platformSubtle().verify('Ed25519', pub, fromB64u(s) as BufferSource, te.encode(`${h}.${p}`))
  } catch { return false }
}

/**
 * Check a vector against the code, from its texts alone: the rows of both
 * key derivations complete (update 0, update 1, auth 0, each once); every
 * key derived anew from the inputs and the stated rule; the genesis
 * commitments (`nextKeyHashes`) and keys of both logs against the derived
 * keys; every field that repeats another equal to it (compact JWS and its
 * decoded parts, POST and token and log, logs and DIDs, link and request,
 * the inputs and the parts built from them, the media type of the POST); the
 * signatures by hand; the wallet accepts the outer link with the given log
 * and Request Object; the service admits the given POST.
 */
export async function checkVector (v: Vector): Promise<string[]> {
  const problems: string[] = []
  const expect = (ok: boolean, what: string): void => { if (!ok) problems.push(what) }
  const i = v.inputs

  // both derivations name exactly the keys the first entry needs, each once
  const rows = (ds: { role: string, index: number }[]): string => ds.map((d) => `${d.role}${d.index}`).sort().join(',')
  const NEEDED = SERVICE_KEYS.map(([r, n]) => `${r}${n}`).sort().join(',')
  expect(Array.isArray(v.service_derivation) && rows(v.service_derivation) === NEEDED, `service_derivation: the rows are not exactly ${NEEDED}`)
  expect(Array.isArray(v.derivation) && rows(v.derivation) === NEEDED, `derivation: the rows are not exactly ${NEEDED}`)

  // the service: keys from the seed, log from the keys, DID and SCID from the log
  const sKeys: Record<string, Uint8Array> = {}
  for (const d of v.service_derivation) {
    const key = await edFromSeed(await hkdf(unhex(i.service.seed), d.hkdf_info))
    sKeys[`${d.role}${d.index}`] = key.pubRaw
    expect(d.hkdf_info === serviceKeyInfo(d.role, d.index), `service ${d.role} ${d.index}: hkdf_info is not the rule's`)
    expect(multikey(key.pubRaw) === d.public_key_multibase, `service ${d.role} ${d.index}: derived key differs`)
  }
  const sLog = fromJsonl(v.service_log) as Entry[] | null
  if (!sLog) return [...problems, 'service log is not JSON Lines']
  const s0 = sLog[0] as Entry
  expect(toJsonl(sLog) === v.service_log, 'service log is not in canonical JSON Lines')
  expect(same(s0.parameters.updateKeys, [multikey(sKeys.update0 ?? new Uint8Array())]), 'service log: update key 0 is not the derived one')
  expect((s0.state.verificationMethod as { publicKeyMultibase: string }[])[0]?.publicKeyMultibase === multikey(sKeys.auth0 ?? new Uint8Array()), 'service log: auth key 0 is not the derived one')
  expect(same(s0.parameters.nextKeyHashes, [await keyHash(multikey(sKeys.update1 ?? new Uint8Array()))]), 'service log: nextKeyHashes is not the hash of the derived update key 1')
  expect(s0.versionTime === i.service.log_time, 'service log: versionTime is not inputs.service.log_time')
  expect(v.service_did === `did:webvh:${String(s0.parameters.scid)}:${i.service.host}`, 'service_did does not name inputs.service.host')
  expect(s0.state.id === v.service_did, 'service_did is not the id in the service log')
  expect(s0.parameters.scid === v.service_scid && v.service_did.startsWith(`did:webvh:${v.service_scid}:`), 'service_scid is not the SCID of the log and the DID')
  const where = locate(v.service_did)
  expect(!('error' in where) && where.logUrl === v.service_log_url, 'service_log_url is not the did:webvh location of service_did')

  // the outer link and the Request Object
  const outer = parseOuter(v.outer_link)
  const clientId = CLIENT_ID_PREFIX + v.service_did
  expect(!('error' in outer) && outer.client_id === clientId && outer.request_uri === v.request_uri, 'outer_link does not carry client_id and request_uri')
  const ro = v.request_object
  expect(same(part(ro.compact, 0), ro.header) && same(part(ro.compact, 1), ro.payload), 'request_object: decoded parts differ from the compact JWS')
  expect(ro.header.kid === `${v.service_did}#key-1`, 'request_object: kid is not the service key')
  expect(await verifies(sKeys.auth0 ?? new Uint8Array(), ro.compact), 'request_object signature under the derived service auth key 0')
  expect(ro.payload.client_id === clientId && ro.payload.nonce === i.nonce && ro.payload.state === i.state, 'request_object: client_id, nonce or state differ from the inputs')
  expect(!('error' in where) && v.request_uri === where.origin + REQUEST_PATH + i.request_id, 'request_uri is not the service origin, the request path and request_id')
  expect((ro.payload.client_metadata as { client_name?: string } | undefined)?.client_name === i.service.name, 'request_object: client_name is not inputs.service.name')
  expect(ro.payload.iat === Math.floor(Date.parse(i.time) / 1000), 'request_object: iat is not inputs.time')

  // the person: keys from the secret and the context, log from the keys, DID from the log
  const k: KeyFor = { method: 'did:webvh', scid: v.service_scid, subjectMethod: v.subject_method }
  const pKeys: Record<string, Uint8Array> = {}
  for (const d of v.derivation) {
    const key = await edFromSeed(await hkdf(unhex(i.person.secret), d.hkdf_info))
    pKeys[`${d.role}${d.index}`] = key.pubRaw
    expect(d.hkdf_info === keyContext(k, d.role, d.index), `person ${d.role} ${d.index}: hkdf_info is not the profile's context`)
    expect(multikey(key.pubRaw) === d.public_key_multibase, `person ${d.role} ${d.index}: derived key differs`)
  }
  const pLog = fromJsonl(v.person_log) as Entry[] | null
  if (!pLog) return [...problems, 'person log is not JSON Lines']
  const p0 = pLog[0] as Entry
  expect(toJsonl(pLog) === v.person_log, 'person log is not in canonical JSON Lines')
  expect(same(p0.parameters.updateKeys, [multikey(pKeys.update0 ?? new Uint8Array())]), 'person log: update key 0 is not the derived one')
  expect((p0.state.verificationMethod as { publicKeyMultibase: string }[])[0]?.publicKeyMultibase === multikey(pKeys.auth0 ?? new Uint8Array()), 'person log: auth key 0 is not the derived one')
  expect(p0.state.id === v.person_did && v.person_did.startsWith(v.subject_method + ':'), 'person_did is not the id in the person log')
  expect(same(p0.parameters.nextKeyHashes, [await keyHash(multikey(pKeys.update1 ?? new Uint8Array()))]), 'person log: nextKeyHashes is not the hash of the derived update key 1')
  expect(p0.versionTime === i.time, 'person log: versionTime is not inputs.time')

  // the ID token
  const t = v.id_token
  expect(same(part(t.compact, 0), t.header) && same(part(t.compact, 1), t.payload), 'id_token: decoded parts differ from the compact JWS')
  expect(t.header.kid === kidOf(v.person_did, (pLog[pLog.length - 1] as Entry).versionId), 'id_token: kid is not the person key under the log head')
  expect(t.payload.iss === v.person_did && t.payload.sub === v.person_did && t.payload.aud === clientId && t.payload.nonce === i.nonce, 'id_token: iss, sub, aud or nonce')
  expect(t.payload.iat === Math.floor(Date.parse(i.time) / 1000), 'id_token: iat is not inputs.time')
  expect(await verifies(pKeys.auth0 ?? new Uint8Array(), t.compact), 'id_token signature under the derived person auth key 0')

  // the POST: the token, the state and the log, to the redirect_uri
  const form = new URLSearchParams(v.post.body)
  expect(same([...form.keys()], ['id_token', 'state', DID_LOG_FIELD]), 'post: fields')
  expect(form.get('id_token') === t.compact && form.get('state') === ro.payload.state && form.get(DID_LOG_FIELD) === v.person_log, 'post: fields differ from id_token, state or person_log')
  expect(v.post.url === ro.payload.redirect_uri, 'post: url is not the redirect_uri')
  expect(v.post.content_type === 'application/x-www-form-urlencoded', 'post: content_type is not application/x-www-form-urlencoded')

  // the code: the wallet accepts the request, the service the POST
  const { service, wallet } = await parts(i, () => ({ [v.service_log_url]: v.service_log, [v.request_uri]: ro.compact }))
  const opened = await wallet.open(v.outer_link)
  if (!opened.ok) problems.unshift(`wallet refuses: ${opened.reason}`)
  await service.start('cross-device')
  const reply = await service.receive(new URLSearchParams(v.post.body))
  if (reply.status !== 200) problems.push(`service refuses: ${JSON.stringify(reply.body)}`)
  expect(same(reply, v.service_reply), 'service_reply differs')
  return problems
}
