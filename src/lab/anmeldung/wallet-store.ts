// Where the demo wallet keeps its test identity. The identity must be the
// same on every login, otherwise the person gets a new account each time.
// So there is no fallback: if the browser cannot store and read back the
// root, the wallet says so before anything is signed (finding #135).

import { b64uOf, fromB64u } from 'rltp-lib'

export const STORE_KEY = 'anmeldung-test-wurzel'

/** The part of the Web Storage API the wallet uses. */
export interface KeyValueStore {
  getItem (key: string): string | null
  setItem (key: string, value: string): void
}

export type StoredRoot =
  | { ok: true, root: Uint8Array, created: boolean }
  | { ok: false, reason: string }

const NOT_KEPT = 'Dieser Browser speichert für diese Seite nichts (privates Fenster oder gesperrter Speicher). Ohne gespeicherte Identität bekämst du bei jeder Anmeldung ein neues Konto.'

/**
 * The persistent test identity: read it, or create, store and read it back.
 * `store` is a function so that a throwing `localStorage` getter is caught too.
 */
export function persistentRoot (store: () => KeyValueStore, random: (n: number) => Uint8Array): StoredRoot {
  try {
    const s = store()
    const kept = s.getItem(STORE_KEY)
    if (kept !== null) {
      const root = fromB64u(kept)
      return root.length === 32 ? { ok: true, root, created: false } : { ok: false, reason: 'Die gespeicherte Identität ist beschädigt.' }
    }
    const fresh = random(32)
    s.setItem(STORE_KEY, b64uOf(fresh))
    if (s.getItem(STORE_KEY) !== b64uOf(fresh)) return { ok: false, reason: NOT_KEPT }   // stored nothing, silently
    return { ok: true, root: fresh, created: true }
  } catch {
    return { ok: false, reason: NOT_KEPT }
  }
}
