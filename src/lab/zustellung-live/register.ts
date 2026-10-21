// Send register and XRFI register (draft 3 §4.3, review 3 C3/C5). Matching uses
// full digests; the protocol shows only 8-hex prefixes.

import { hexOf } from './util'

export type Kind = 'probe' | 'doc' | 'ack'
export type Dir = 'x2y' | 'y2x'

export interface SendRecord {
  id: string
  group: string
  form: string
  stage: 0 | 1
  rel: 'AB' | 'AC'
  dir: Dir
  run: number
  kind: Kind
  payloadDigest: string
  innerDigest: string
  outerDigest: string | null
  sizes: { payload: number; inner: number; outer: number | null; wire: number }
  tSend: number
  /** Socket label the receiver should see it on. */
  receiverSocket: string
  /** For an ack: the doc row it acknowledges. */
  docRow?: string
}

export type Layer = 'inner' | 'outer'

export class SendRegistry {
  private readonly records: SendRecord[] = []
  private readonly byFrame = new Map<string, { record: SendRecord; layer: Layer }>()
  private readonly byPayload = new Map<string, SendRecord>()
  add(r: SendRecord) {
    this.records.push(r)
    this.byFrame.set(r.innerDigest, { record: r, layer: 'inner' })
    if (r.outerDigest) this.byFrame.set(r.outerDigest, { record: r, layer: 'outer' })
    this.byPayload.set(r.payloadDigest, r)
  }
  frame(digest: string) {
    return this.byFrame.get(digest)
  }
  payload(digest: string) {
    return this.byPayload.get(digest)
  }
  get(id: string) {
    return this.records.find((r) => r.id === id)
  }
  all(): readonly SendRecord[] {
    return this.records
  }
}

export interface XrfiEntry {
  group: string
  socket: string
  /** `PackedMessage.threadDigest` of the invite, full hex: XRFA/XRFD name it in `inReplyTo`. */
  threadDigest: string
  tSend: number
}

export class XrfiRegistry {
  private readonly entries: XrfiEntry[] = []
  add(e: XrfiEntry) {
    this.entries.push(e)
  }
  /** Correlation of a control frame's `inReplyTo` on a socket. */
  correlate(socket: string, inReplyTo: Uint8Array | undefined): 'own-xrfi' | 'unknown' | 'none' {
    if (!inReplyTo) return 'none'
    const h = hexOf(inReplyTo)
    return this.entries.some((e) => e.socket === socket && e.threadDigest === h) ? 'own-xrfi' : 'unknown'
  }
  all(): readonly XrfiEntry[] {
    return this.entries
  }
}
