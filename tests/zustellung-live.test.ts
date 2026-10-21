// E11b step 1: live probe of Rev 3 routed TSP against the VTI mediator
// (draft 3 with the build decisions after review 3). Skipped unless
// RLTP_LIVE_MEDIATOR=1. Writes the protocol JSON to E11B_PROTOCOL_OUT or
// `.cache/e11b-live/<UTC-ISO>.json`. Never part of the report.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseEnv, protocolJson, runLiveProbe, translate } from '../src/lab/zustellung-live'

// Long live run: test and hook timeouts set in this file only, not globally (review 3 H2).
const LIVE_TIMEOUT_MS = 4 * 60 * 60 * 1000
vi.setConfig({ testTimeout: LIVE_TIMEOUT_MS, hookTimeout: LIVE_TIMEOUT_MS })

const live = process.env.RLTP_LIVE_MEDIATOR === '1'
const version = (pkg: string) => (JSON.parse(readFileSync(join('node_modules', pkg, 'package.json'), 'utf8')) as { version: string }).version

describe.skipIf(!live)('E11b live probe against the VTI mediator', () => {
  it(
    'runs every form, writes the protocol, every row has an outcome, exactly one probe outcome',
    async () => {
      const cfg = parseEnv(process.env)
      const run = await runLiveProbe(cfg, {
        versions: { tsp: version('@openvtc/vti-tsp-js'), didcomm: version('@openvtc/vti-didcomm-js'), trustProtocol: version('@real-life/trust-protocol'), node: process.version },
        stderr: (line) => process.stderr.write(line + '\n'),
      })
      const json = protocolJson(run.protocol)
      const out = cfg.protocolOut ?? join('.cache', 'e11b-live', `${new Date().toISOString().replace(/:/g, '-')}.json`)
      try {
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, json)
      } catch (e) {
        throw translate(e, 'write')
      }
      const p = JSON.parse(json)
      expect(p.result.outcome).not.toBe('other')
      for (const r of p.rows) expect(['positive', 'late', 'not-shown']).toContain(r.outcome)
      // Internal failures (classifier or consumer exceptions) invalidate the run; observations are kept in the file.
      if (!run.valid) throw run.failures[0]
    },
    LIVE_TIMEOUT_MS,
  )
})
