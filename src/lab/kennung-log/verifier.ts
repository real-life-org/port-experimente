// The verifier of a service that holds state: one verifier, one copy of each
// identifier's log. It applies what did:vh calls "Applying Peer-to-Peer
// Updates" to the log that comes with each login, and checks the login
// token against the head of the log it then holds.
//
// The token is a compact JWS (EdDSA, Ed25519) shaped like the ID token of
// src/lab/anmeldung/siop.ts. Its `kid` is a DID URL with the DID Core
// parameter `versionId`: `<did>?versionId=<versionId>#<fragment>`, the head
// under which it was signed and the key it was signed with.

import { b64uOf, fromB64u, platformSubtle, type KeyPair } from 'rltp-lib'
import { authenticationKeys, verify, type Entry, type Profile, type Version } from './log'

export interface TokenClaims {
  iss: string
  sub: string
  aud: string
  nonce: string
  iat: number
  exp: number
}

const te = new TextEncoder(), td = new TextDecoder()
const b64uJson = (o: unknown): string => b64uOf(te.encode(JSON.stringify(o)))

/** The key id a token names: the DID URL of a key under one version. */
export const kidOf = (did: string, versionId: string, fragment = 'key-1'): string => `${did}?versionId=${versionId}#${fragment}`

export async function signToken (key: KeyPair, kid: string, claims: TokenClaims): Promise<string> {
  const input = `${b64uJson({ alg: 'EdDSA', typ: 'JWT', kid })}.${b64uJson(claims)}`
  const sig = new Uint8Array(await platformSubtle().sign('Ed25519', key.priv, te.encode(input)))
  return `${input}.${b64uOf(sig)}`
}

/** What the service holds of one identifier. `contested` is set by a second
 *  valid continuation and never cleared here: settling it is not modelled. */
export interface Held {
  log: Entry[]
  head: Version
  evidence: Entry[][]
  contested: boolean
}

export type LoginResult =
  | { kind: 'ok', did: string, versionId: string, step: 'first contact' | 'same head' | 'continued' }
  | { kind: 'stale', did: string, held: string }
  | { kind: 'contested', did: string, held: string }
  | { kind: 'invalid', reason: string }

export interface LoginInput {
  log: unknown
  token: string
  /** The nonce of the request this answer is for. */
  nonce: string
}

type Relation = 'same' | 'extends' | 'behind' | 'diverges'
/** How a verified copy relates to the held one ("Comparing Copies of a DID
 *  Log"): one `versionId` decides, because each entry hash covers the one
 *  before it. */
function relate (held: Entry[], copy: Entry[]): Relation {
  const k = Math.min(held.length, copy.length) - 1
  if (held[k]?.versionId !== copy[k]?.versionId) return 'diverges'
  return copy.length === held.length ? 'same' : copy.length > held.length ? 'extends' : 'behind'
}

export class Verifier {
  private readonly held = new Map<string, Held>()

  constructor (private readonly o: { profile: Profile, audience: string, now: () => Date, toleranceSec?: number }) {}

  /** What the service holds of a DID (a copy). */
  holding (did: string): Held | undefined {
    const h = this.held.get(did)
    return h && structuredClone(h)
  }

  async login (input: LoginInput): Promise<LoginResult> {
    const now = this.o.now()
    const check = await verify(input.log, { profile: this.o.profile, now, toleranceSec: this.o.toleranceSec })
    if (!check.ok) return { kind: 'invalid', reason: `log: ${check.reason} (entry ${check.at + 1})` }
    const log = input.log as Entry[]
    const { did } = check
    const held = this.held.get(did)

    let head: Version
    let step: 'first contact' | 'same head' | 'continued'
    if (!held) { head = check.head; step = 'first contact' } else {
      const rel = relate(held.log, log)
      if (rel === 'diverges') {
        // A second valid continuation: kept as evidence of duplicity; from
        // now on no login for this DID is accepted.
        if (!held.evidence.some((e) => e[e.length - 1]?.versionId === log[log.length - 1]?.versionId)) held.evidence.push(structuredClone(log))
        held.contested = true
        return { kind: 'contested', did, held: held.head.versionId }
      }
      if (held.contested) return { kind: 'contested', did, held: held.head.versionId }
      if (rel === 'behind') return { kind: 'stale', did, held: held.head.versionId }
      if (rel === 'same') { head = held.head; step = 'same head' } else { head = check.head; step = 'continued' }
    }

    if (head.deactivated) {
      // A deactivation stands without a login: it is signed by the update keys.
      this.held.set(did, { log: structuredClone(log), head, evidence: held?.evidence ?? [], contested: false })
      return { kind: 'invalid', reason: 'the DID is deactivated' }
    }

    const token = await checkToken(input.token, did, head, this.o.audience, input.nonce, now)
    if (token !== null) return { kind: 'invalid', reason: `token: ${token}` }

    // The log moves only together with a login that holds under its head.
    if (step !== 'same head') this.held.set(did, { log: structuredClone(log), head, evidence: held?.evidence ?? [], contested: false })
    return { kind: 'ok', did, versionId: head.versionId, step }
  }
}

/** Checks a token against one head. Returns null when it holds, else why not. */
async function checkToken (token: string, did: string, head: Version, audience: string, nonce: string, now: Date): Promise<string | null> {
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3) return 'not a compact JWS'
  const [h, p, s] = parts as [string, string, string]
  let header: any, claims: any
  try { header = JSON.parse(td.decode(fromB64u(h))); claims = JSON.parse(td.decode(fromB64u(p))) } catch { return 'not readable' }
  if (header?.alg !== 'EdDSA') return 'not EdDSA'
  if (claims?.iss !== did || claims?.sub !== did) return 'iss and sub are not the DID'
  const kid = typeof header.kid === 'string' ? header.kid : ''
  const m = /^([^?#]+)\?versionId=([^&#]+)#([^?#]+)$/.exec(kid)
  if (!m || m[1] !== did) return 'kid is not a key of this DID'
  if (m[2] !== head.versionId) return 'signed under another version than the head'
  const raw = authenticationKeys(head.doc).get(`${did}#${m[3]}`)
  if (!raw) return 'kid is not an authentication key of the head'
  let good = false
  try {
    const pub = await platformSubtle().importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, ['verify'])
    good = await platformSubtle().verify('Ed25519', pub, fromB64u(s) as BufferSource, te.encode(`${h}.${p}`))
  } catch { good = false }
  if (!good) return 'signature does not verify'
  if (claims.aud !== audience) return 'another audience'
  if (claims.nonce !== nonce) return 'another nonce'
  const t = Math.floor(now.getTime() / 1000)
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > t + 60 || claims.exp <= t) return 'outside its time'
  return null
}
