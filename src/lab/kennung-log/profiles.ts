// The three names under discussion, as settings of log.ts. Which one a
// login identifier takes is open (didwebvh#305); nothing else in this
// directory depends on the choice.
import type { Profile } from './log'

const COMMON = ['method', 'scid', 'updateKeys', 'nextKeyHashes', 'witness', 'watchers', 'deactivated', 'ttl'] as const

/** did:webvh 1.0, with a host (and optional path segments, already encoded). */
export const webvh = (host: string): Profile => ({
  did: `did:webvh:{SCID}:${host}`,
  method: 'did:webvh:1.0',
  parameters: [...COMMON, 'portable'],
})

/** did:vh (editor's draft): no host, `method` `did:vh:1.0`, no `portable`. */
export const vh: Profile = {
  did: 'did:vh:{SCID}',
  method: 'did:vh:1.0',
  parameters: COMMON,
}

/**
 * did:scid:vh:1 with the did:vh log format. No text defines this case: the
 * did:vh draft says in its note "Future use by did:scid:vh" that the `id`
 * would then be the did:scid:vh DID "while the rest of the DID Log is
 * created and verified as defined here". `method` `did:vh:1.0` is our
 * reading of that note, not a specified value.
 */
export const scidVh: Profile = {
  did: 'did:scid:vh:1:{SCID}',
  method: 'did:vh:1.0',
  parameters: COMMON,
}
