// Der Schlüssel-Port des Kandidaten als Schnittstelle (E13): dieselbe Autorität,
// dieselben Rahmen, zwei Schlüsselvarianten darunter. BeeKEM (Keyhives CGKA,
// E6–E10) und MLS (RFC 9420 über OpenMLS, E13). Beide liefern signierte
// Operationen als Bytes, einen Eintragsschlüssel je Referenz und die Kette
// der Vorgänger über die Tabelle des Kandidaten. Unterschiede, die der
// Kandidat kennt: MLS braucht ein Willkommen an den Neuen (reist in unserem
// `welcome`-Rahmen), MLS rotiert beim Schreiben nicht (kein `updateOp`), und
// gleichzeitige Commits löst MLS über den niedrigsten Hash (`lost`). Der
// Vertrag zur Epochenwahl steht in rust/mls-wasm/src/peer.rs; der Kandidat
// trägt seinen Teil: Rahmen, die unter einer verfallenen Epoche versiegelt
// wurden, versiegelt ihr Autor neu (`lost`, `reset`).

import { BeekemPeer, loadWasm as loadBeekem } from './load'
import { MlsPeer, loadWasm as loadMls } from '../rltp-mls/load'

export interface KeyPeer {
  readonly id: Uint8Array
  readonly shareKey: Uint8Array
  create(group: Uint8Array): Promise<Uint8Array[]>
  /** BeeKEM: Baum beitreten, bevor Operationen kommen. MLS: nichts (Beitritt nur über `welcome`). */
  join(group: Uint8Array): void
  /** MLS: Beitritt über das Willkommen aus `add`. BeeKEM hat keins (die Geheimnisse stecken in der Aufnahme). `reset`: die eigene Gruppe stand auf einem verfallenen Zweig und ist ersetzt; `own`: schon drin. */
  welcome?(bytes: Uint8Array): 'ok' | 'reset' | 'own'
  add(memberId: Uint8Array, shareKey: Uint8Array): Promise<{ op: Uint8Array | null; welcome?: Uint8Array }>
  remove(memberId: Uint8Array): Promise<Uint8Array | null>
  rotate(): Promise<Uint8Array>
  /** Wirft, wenn die Operation noch nicht passt (Vorgänger fehlen). `lost`: Tiebreak verloren, der fremde Commit gilt, eigener Zustand zurückgefallen. `stale`: nie mehr anwendbar. `reset`: s. `welcome`. */
  receive(bytes: Uint8Array): 'ok' | 'own' | 'lost' | 'stale' | 'reset'
  /** Lineare Ports: die aktuelle Epoche; sonst 0. */
  epoch(): number
  encrypt(ref: Uint8Array, preds: Uint8Array[], plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; updateOp: Uint8Array | null; appKey: Uint8Array }>
  decrypt(ciphertext: Uint8Array): { plaintext: Uint8Array; appKey: Uint8Array }
  decryptWithKey(ciphertext: Uint8Array, key: Uint8Array): Uint8Array
  members(): Uint8Array[]
  hasKey(): boolean
  exportState(): Uint8Array
}

export interface KeyPort {
  readonly name: 'beekem' | 'mls'
  /** Linear: je Epoche genau ein Commit (MLS). Dann heilt je Gruppe nur ein bestimmtes Mitglied (KV6 über Heilung), nicht alle zugleich. */
  readonly linear: boolean
  load(): Promise<void>
  peer(): KeyPeer
  fromState(bytes: Uint8Array): KeyPeer
}

class BeekemAdapter implements KeyPeer {
  constructor(private readonly p: BeekemPeer) {}
  get id() {
    return new Uint8Array(this.p.id)
  }
  get shareKey() {
    return new Uint8Array(this.p.shareKey)
  }
  create(group: Uint8Array) {
    return this.p.create(group) as Promise<Uint8Array[]>
  }
  join(group: Uint8Array) {
    this.p.join(group)
  }
  async add(memberId: Uint8Array, shareKey: Uint8Array) {
    return { op: (await this.p.add(memberId, shareKey)) as Uint8Array | null }
  }
  remove(memberId: Uint8Array) {
    return this.p.remove(memberId) as Promise<Uint8Array | null>
  }
  rotate() {
    return this.p.rotate() as Promise<Uint8Array>
  }
  receive(bytes: Uint8Array) {
    this.p.receive(bytes)
    return 'ok' as const
  }
  epoch() {
    return 0
  }
  encrypt(ref: Uint8Array, preds: Uint8Array[], plaintext: Uint8Array) {
    return this.p.encrypt(ref, preds, plaintext) as Promise<{ ciphertext: Uint8Array; updateOp: Uint8Array | null; appKey: Uint8Array }>
  }
  decrypt(ciphertext: Uint8Array) {
    return this.p.decrypt(ciphertext) as { plaintext: Uint8Array; appKey: Uint8Array }
  }
  decryptWithKey(ciphertext: Uint8Array, key: Uint8Array) {
    return BeekemPeer.decryptWithKey(ciphertext, key)
  }
  members() {
    return this.p.members() as Uint8Array[]
  }
  hasKey() {
    return this.p.hasKey()
  }
  exportState() {
    return new Uint8Array(this.p.exportState())
  }
}

class MlsAdapter implements KeyPeer {
  constructor(private readonly p: MlsPeer) {}
  get id() {
    return new Uint8Array(this.p.id)
  }
  get shareKey() {
    return new Uint8Array(this.p.shareKey)
  }
  async create(group: Uint8Array) {
    return Array.from(this.p.create(group)) as Uint8Array[]
  }
  join() {
    // MLS: Beitritt nur über das Willkommen.
  }
  welcome(bytes: Uint8Array) {
    // Das Willkommen ist ein Rahmen des Schlüssel-Ports wie ein Commit; die Hülle erkennt ihn.
    return this.p.receive(bytes) as 'ok' | 'reset' | 'own'
  }
  epoch() {
    return this.p.epoch()
  }
  async add(memberId: Uint8Array, shareKey: Uint8Array) {
    const r = this.p.add(memberId, shareKey) as { op: Uint8Array; welcome: Uint8Array }
    return { op: r.op, welcome: r.welcome }
  }
  async remove(memberId: Uint8Array) {
    return this.p.remove(memberId) as Uint8Array | null
  }
  async rotate() {
    return this.p.rotate()
  }
  receive(bytes: Uint8Array) {
    return this.p.receive(bytes) as 'ok' | 'own' | 'lost' | 'stale' | 'reset'
  }
  async encrypt(ref: Uint8Array, preds: Uint8Array[], plaintext: Uint8Array) {
    return this.p.encrypt(ref, preds, plaintext) as { ciphertext: Uint8Array; updateOp: Uint8Array | null; appKey: Uint8Array }
  }
  decrypt(ciphertext: Uint8Array) {
    return this.p.decrypt(ciphertext) as { plaintext: Uint8Array; appKey: Uint8Array }
  }
  decryptWithKey(ciphertext: Uint8Array, key: Uint8Array) {
    return MlsPeer.decryptWithKey(ciphertext, key)
  }
  members() {
    return Array.from(this.p.members()) as Uint8Array[]
  }
  hasKey() {
    return this.p.hasKey()
  }
  exportState() {
    return new Uint8Array(this.p.exportState())
  }
}

export const beekemPort: KeyPort = {
  name: 'beekem',
  linear: false,
  load: loadBeekem,
  peer: () => new BeekemAdapter(new BeekemPeer()),
  fromState: (bytes) => new BeekemAdapter(BeekemPeer.fromState(bytes)),
}

export const mlsPort: KeyPort = {
  name: 'mls',
  linear: true,
  load: loadMls,
  peer: () => new MlsAdapter(new MlsPeer()),
  fromState: (bytes) => new MlsAdapter(MlsPeer.fromState(bytes)),
}
