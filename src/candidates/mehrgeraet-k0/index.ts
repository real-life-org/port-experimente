// K0: one seed, today. Every device derives all keys from the same seed;
// each device keeps its own holder state; nothing is merged (plan E15,
// section 3: the deliberately uncoordinated multi-device operation, no
// HSC-020 implementation). The baseline that must visibly fail X1, X2, X3
// and X7.

import { seedScheme, type CandidateDevice, type HolderDevice, type MultiDeviceCandidate } from '../../lab/mehrgeraet/holder'

export function k0(): MultiDeviceCandidate {
  const seeds = new Map<string, Uint8Array>()
  const incarnation = new Map<string, number>()
  const device = (person: string, name: string, seed: Uint8Array): CandidateDevice => {
    const n = (incarnation.get(name) ?? 0) + 1
    incarnation.set(name, n)
    return {
      keys: seedScheme(seed),
      writer: `${name}@${n}`,
      commit() {},
      takeOwnFrames: () => [],
      receiveOwnFrame: () => ({ ops: [], intents: [] }),
      persist: () => null,
      restore() {},
    }
  }
  return {
    id: 'k0-one-seed',
    title: 'K0: one seed, each device its own state, no merge',
    capabilities: new Set(),
    async first(person, name, seed) {
      seeds.set(person, seed)
      return device(person, name, seed)
    },
    async enrol(from: HolderDevice, name) {
      // Enrollment heute: der Seed wandert, der Zustand wird einmal kopiert.
      return { cand: device(from.person, name, seeds.get(from.person)!), state: structuredClone(from.state) }
    },
  }
}
