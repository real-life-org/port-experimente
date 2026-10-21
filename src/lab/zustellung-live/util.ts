// Small helpers shared by the E11b live probe (E11b step 1). Digests are full
// SHA-256 hex internally; only `short8` is ever shown.

import { sha256 } from '@noble/hashes/sha2.js'

export const enc = new TextEncoder()
export const dec = new TextDecoder()

export const hexOf = (u8: Uint8Array): string => Buffer.from(u8).toString('hex')
export const sha256hex = (bytes: Uint8Array): string => hexOf(sha256(bytes))
/** Display form of a digest: the first 8 hex characters. Never used for matching. */
export const short8 = (hex: string): string => hex.slice(0, 8)

/** Source of entropy. Injectable so the offline tests can sweep seeds and plant markers. */
export type Rand = (n: number) => Uint8Array

export const cryptoRand: Rand = (n) => crypto.getRandomValues(new Uint8Array(n))

/** Deterministic entropy for seed sweeps: SHA-256 over (seed, counter). Tests only. */
export function seededRand(seed: number): Rand {
  let counter = 0
  return (n) => {
    const out = new Uint8Array(n)
    let off = 0
    while (off < n) {
      const block = sha256(enc.encode(`e11b-seed:${seed}:${counter++}`))
      const take = Math.min(block.length, n - off)
      out.set(block.subarray(0, take), off)
      off += take
    }
    return out
  }
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2)
}
