import { describe, expect, it } from 'vitest'
import type { ManagedTransport, WebSocketEndpointInterface } from '@automerge/automerge-repo'
import { GatedEndpoint } from '../src/candidates/keyhive-ark'

function fakeInner() {
  const pending: Array<(t: ManagedTransport) => void> = []
  const made: Array<{ t: ManagedTransport; disconnected: boolean }> = []
  const inner: WebSocketEndpointInterface = {
    url: 'ws://fake',
    connect: () =>
      new Promise<ManagedTransport>((resolve) => {
        pending.push(resolve)
      }),
  }
  /** Lässt den ältesten laufenden Verbindungsaufbau fertig werden. */
  const complete = () => {
    const rec = { t: undefined as unknown as ManagedTransport, disconnected: false }
    rec.t = {
      sendBytes: async () => {},
      recvBytes: async () => new Uint8Array(),
      onDisconnect: () => {},
      closed: () => new Promise<void>(() => {}),
      disconnect: async () => {
        rec.disconnected = true
      },
    }
    made.push(rec)
    pending.shift()!(rec.t)
    return rec
  }
  return { inner, complete, made }
}

describe('GatedEndpoint (Offline-Schalter für den ARK-Kandidaten)', () => {
  it('trennt eine Verbindung, die erst nach dem Offline-Schalten fertig wird, und wartet dann', async () => {
    const f = fakeInner()
    const ep = new GatedEndpoint('ws://fake', f.inner)
    const connecting = ep.connect()
    await ep.setOnline(false)
    const rec = f.complete() // Aufbau wird erst jetzt fertig: das Rennen
    await new Promise((r) => setTimeout(r, 10))
    expect(rec.disconnected, 'verspätete Verbindung muss getrennt werden').toBe(true)
    expect(ep.openTransports).toBe(0)
    let settled = false
    void connecting.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(settled, 'offline darf connect() nicht auflösen').toBe(false)
    await ep.setOnline(true)
    f.complete()
    const t = await connecting
    expect(t).toBeDefined()
    expect(ep.openTransports).toBe(1)
  })

  it('trennt offene Verbindungen beim Offline-Schalten', async () => {
    const f = fakeInner()
    const ep = new GatedEndpoint('ws://fake', f.inner)
    const p = ep.connect()
    const rec = f.complete()
    await p
    expect(ep.openTransports).toBe(1)
    await ep.setOnline(false)
    expect(rec.disconnected).toBe(true)
  })
})
