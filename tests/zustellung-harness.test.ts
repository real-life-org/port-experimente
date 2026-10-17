import { describe, expect, it } from 'vitest'
import { Device, HORIZON, MemoryStore, VirtualClock, Welt, party, sealDoc, type DeviceState } from '../src/lab/zustellung'
import { labWire } from '../src/candidates/zustellung/lab'

// E15-Harness (Plan Runde 3, Abschnitt 2): Erweiterungen des E11-Prüfstands,
// die der Mehrgeräte-Prüfstand braucht. Die E11-Szenarien (zustellung.test.ts)
// laufen mit den Defaults unverändert.

const DAY = 24 * 3600 * 1000

describe('E15-Harness: virtuelle Uhr', () => {
  it('Dokumente tragen die Zeit der virtuellen Uhr; Runden bewegen sie nicht, nur advance/set', async () => {
    const clock = new VirtualClock('2026-10-17T08:00:00.000Z')
    const w = new Welt(labWire(), { clock })
    const { A, B } = await w.pair(await party('alice'), await party('bob'))
    await A.send({ note: 'eins' })
    await w.rounds(5)
    expect(B.received[0]!.doc.issuedAt).toBe('2026-10-17T08:00:00.000Z')
    clock.advance(28 * DAY)
    await A.send({ note: 'zwei' })
    await w.rounds(3)
    expect(B.received[1]!.doc.issuedAt).toBe('2026-11-14T08:00:00.000Z')
    clock.set('2026-10-01T00:00:00.000Z') // Uhr-Rückstellung
    expect(clock.now()).toBe('2026-10-01T00:00:00.000Z')
    expect(clock.skewed(-60_000).now()).toBe('2026-09-30T23:59:00.000Z') // Geräteversatz
  })
})

describe('E15-Harness: Fehler-Fassade am Träger (Muster CarrierFaults)', () => {
  it('drop: der Rahmen wird getragen, nie zugestellt; der Zusteller wiederholt; nach reset kommt er an', async () => {
    const w = new Welt(labWire())
    const { A, B } = await w.pair(await party('alice'), await party('bob'))
    w.carrier.faults.drop((f) => f.address === B.endpoint.address)
    const d = await A.send({ note: 'weg' })
    await w.rounds(HORIZON.ackWait + 1)
    expect(B.received.length).toBe(0)
    expect(w.carrier.swallowed.length).toBeGreaterThanOrEqual(1)
    expect(A.zusteller.submissions.get(d)!.deposits).toBeGreaterThanOrEqual(2)
    w.carrier.faults.reset()
    const n = await w.until(() => A.zusteller.report(d)?.state === 'delivered')
    expect(n).toBeGreaterThan(0)
    expect(B.received.length).toBe(1)
  })

  it('withhold: ein Gerät einer Adresse bekommt den Rahmen nicht, das andere schon; der Rahmen bleibt liegen, bis die Regel fällt', async () => {
    const w = new Welt(labWire())
    const { A, B, more } = await w.pair(await party('alice'), await party('bob'), ['bob-2'])
    const B2 = more[0]!
    w.carrier.faults.withhold('bob-2', () => true)
    await A.send({ note: 'nur-bob' })
    await w.until(() => B.received.length === 1)
    await w.rounds(3)
    expect(B2.received.length).toBe(0)
    expect(w.carrier.pending(B.endpoint.address)).toBe(1)
    w.carrier.faults.reset()
    await w.until(() => B2.received.length === 1)
    expect(w.carrier.pending(B.endpoint.address)).toBe(0)
  })

  it('reverse: Rahmen einer Runde kommen in umgekehrter Reihenfolge', async () => {
    const w = new Welt(labWire())
    const { A, B } = await w.pair(await party('alice'), await party('bob'))
    B.online = false
    await A.send({ note: 'eins' })
    await A.send({ note: 'zwei' })
    w.carrier.faults.reverse(true)
    B.online = true
    await w.rounds(1)
    expect(B.received.map((r) => (r.doc.payload as { note: string }).note)).toEqual(['zwei', 'eins'])
  })

  it('duplicate: jeder Rahmen kommt zweimal; der Empfänger dedupliziert, Wirkung einmal', async () => {
    const w = new Welt(labWire())
    const { A, B } = await w.pair(await party('alice'), await party('bob'))
    w.carrier.faults.duplicate(true)
    const d = await A.send({ note: 'doppelt' })
    await w.until(() => A.zusteller.report(d)?.state === 'delivered')
    expect(B.received.length).toBe(1)
    expect(B.dispositions).toContain('duplicate-known')
  })

  it('unregister: ein widerrufenes Gerät blockiert die Bereinigung nicht und bekommt nichts mehr', async () => {
    const w = new Welt(labWire())
    const { A, B, more } = await w.pair(await party('alice'), await party('bob'), ['bob-2'])
    const B2 = more[0]!
    B2.online = false
    const d = await A.send({ note: 'vor-dem-widerruf' })
    await w.until(() => B.received.length === 1)
    expect(w.carrier.pending(B.endpoint.address)).toBe(1) // wartet auf bob-2
    w.carrier.unregister('bob-2')
    expect(w.carrier.pending(B.endpoint.address)).toBe(0)
    B2.online = true
    await w.until(() => A.zusteller.report(d)?.state === 'delivered')
    await w.rounds(2)
    expect(B2.received.length).toBe(0)
  })
})

describe('E15-Harness: Store, Commit-Grenzen, Absturz, Backup', () => {
  const stores = () => {
    const m = new Map<string, MemoryStore<DeviceState>>()
    const w = new Welt(labWire(), {
      store: (name) => {
        const s = new MemoryStore<DeviceState>()
        m.set(name, s)
        return s
      },
    })
    return { w, m }
  }

  it('Absturz vor dem Commit: die Wirkung ist weg, der Rahmen liegt noch am Träger, Wirkung danach genau einmal', async () => {
    const { w, m } = stores()
    const { A, B } = await w.pair(await party('alice'), await party('bob'))
    B.crashAt = 'before-commit'
    const d = await A.send({ note: 'eins' })
    await w.rounds(1)
    expect(B.crashes).toEqual(['before-commit'])
    expect(B.received.length).toBe(1) // im Speicher, nie gesichert
    B.reload()
    expect(B.received.length).toBe(0)
    expect(w.carrier.pending(B.endpoint.address)).toBe(1)
    await w.until(() => A.zusteller.report(d)?.state === 'delivered')
    expect(B.received.length).toBe(1)
    expect(m.get('bob')!.commits).toBeGreaterThan(0)
  })

  it('Absturz nach dem Commit, vor der Bestätigung: der Rahmen kommt noch einmal, die Wirkung bleibt einmal', async () => {
    const { w } = stores()
    const { A, B } = await w.pair(await party('alice'), await party('bob'))
    B.crashAt = 'after-commit'
    const d = await A.send({ note: 'zwei' })
    await w.rounds(1)
    expect(B.crashes).toEqual(['after-commit'])
    B.reload()
    expect(B.received.length).toBe(1)
    expect(w.carrier.pending(B.endpoint.address)).toBe(1)
    await w.until(() => A.zusteller.report(d)?.state === 'delivered')
    expect(B.received.length).toBe(1)
    expect(B.dispositions).toContain('duplicate-known')
  })

  it('Absturz vor dem Versand: die Einlieferung ist gesichert, nach dem Neuaufbau geht sie hinaus', async () => {
    const { w } = stores()
    const { A, B } = await w.pair(await party('alice'), await party('bob'))
    A.crashAt = 'before-send'
    const d = await A.send({ note: 'drei' })
    expect(A.crashes).toEqual(['before-send'])
    expect(w.carrier.carried.length).toBe(0)
    A.reload()
    expect(A.zusteller.report(d)).toBeNull()
    const n = await w.until(() => A.zusteller.report(d)?.state === 'delivered')
    expect(n).toBeGreaterThan(0)
    expect(B.received.length).toBe(1)
    expect(A.zusteller.submissions.get(d)!.deposits).toBe(1)
  })

  it('Backup: ein alter Store-Stand zurückgespielt, das Gerät kennt Späteres nicht mehr', async () => {
    const { w, m } = stores()
    const { A, B } = await w.pair(await party('alice'), await party('bob'))
    const d1 = await A.send({ note: 'vorher' })
    await w.until(() => A.zusteller.report(d1)?.state === 'delivered')
    const backup = m.get('alice')!.snapshot()
    const d2 = await A.send({ note: 'nachher' })
    await w.until(() => A.zusteller.report(d2)?.state === 'delivered')
    expect(B.received.length).toBe(2)
    m.get('alice')!.restore(backup)
    A.reload()
    expect(A.zusteller.report(d1)?.state).toBe('delivered')
    expect(A.zusteller.report(d2)).toBeNull()
  })
})

describe('E15-Harness: Schlüsselauflösung je Gerät', () => {
  it('ein Gerät mit zwei Beziehungsschlüsseln öffnet, was an den zweiten versiegelt ist; ohne Resolver nicht', async () => {
    const a = await party('alice')
    const b = await party('bob')
    const b2 = await party('bob-zweiter-schlüssel')
    const seal = async (w: Welt) => {
      const { bytes } = await sealDoc(a, b2, { note: 'an-den-zweiten' }, 'thread-1')
      w.carrier.deposit(b.rkid, bytes)
    }
    const w1 = new Welt(labWire())
    const e = await w1.wire.bind(a, b)
    const Bx = new Device('bob', b, e.b, a, e.a, w1.carrier, { resolve: (rkid) => (rkid === b.rkid ? b.x.priv : rkid === b2.rkid ? b2.x.priv : undefined) })
    w1.devices.push(Bx)
    await seal(w1)
    await w1.rounds(2)
    expect(Bx.received.length).toBe(1)

    const w2 = new Welt(labWire())
    const { B } = await w2.pair(a, b)
    await seal(w2)
    await w2.rounds(2)
    expect(B.received.length).toBe(0)
  })
})
