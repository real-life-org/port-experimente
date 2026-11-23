import type { RunKind } from '../lab/matrix'

// Every candidate of the report with its family, without its code: the
// assembly of the matrix reads result files and must not load a candidate
// (WASM packages, server processes). tests/matrix-page.test.ts holds this
// list against the candidate lists that carry the code.
export const knownCandidates: ReadonlyArray<{ id: string; kind: RunKind }> = [
  ...['gen2', 'p2panda', 'keyhive', 'rltp-beekem', 'rltp-beekem-sichten', 'rltp-mls', 'rltp-mls-sichten', 'consensual-mls-any-staged', 'consensual-mls-owner', 'rltp-beekem-logreplik', 'klartext', 'keyhive-ark', 'rltp-beekem-pws', 'rltp-beekem-datarooms'].map((id) => ({ id, kind: 'group' as const })),
  ...['k0-one-seed', 'k1a-static', 'k1a-journal-service', 'k2-device-keys'].map((id) => ({ id, kind: 'multidevice' as const })),
  ...['lib-one-writer', 'layer-d-prototype'].map((id) => ({ id, kind: 'everyday' as const })),
]
