// The carrier and the friend for the invitation cut: hands documents on
// between the person's devices and one counterpart until nothing moves.
import { clk, short, tick, type Person } from './fixture'
import type { Device } from './invitation'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The carrier and the friend: hands documents on until nothing moves.
 *  `reach`: which of A's devices the carrier reaches. Returns what B refused. */
export async function carry (B: Person, _devices: Device[], reach: Device[], first: any[], rounds = 10): Promise<string[]> {
  const refusedByB: string[] = []
  let toA: any[] = [], toB: any[] = []
  const sort = async (docs: any[]): Promise<void> => {
    for (const o of docs) (Object.hasOwn((await B.read()).addresses.keys, o.envelope.rkid) ? toB : toA).push(o)
  }
  await sort(first)
  for (let r = 0; r < rounds; r++) {
    const t = tick()
    await sort((await B.h.resume(clk(B, t))).outbound)
    for (const D of reach) await sort(D.toCarrier((await D.P.h.resume(clk(D.P, t))).outbound))
    if (!toA.length && !toB.length) break
    const [a, b] = [toA, toB]; toA = []; toB = []
    for (const o of b) {
      const got = await B.h.receive(o.envelope, clk(B, t))
      if (got.disposition === 'unique' || got.disposition === 'duplicate-known') await sort(got.outbound)
      else refusedByB.push(`${short(o.type)}: ${got.reason ?? got.disposition}`)
    }
    for (const o of a) for (const D of reach) await sort(D.toCarrier(await D.receive(o.envelope, t)))
  }
  return [...new Set(refusedByB)].sort()
}
