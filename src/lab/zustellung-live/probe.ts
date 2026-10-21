// The E11b live probe (draft 3 §3–§6 with the build decisions after review 3).
// Runs the forms against a `MediatorPort` (the live mediator, or a fake in the
// offline tests), keeps the registers, evaluates rows and aggregations, and
// returns a protocol object that leaves only through `protocolJson`.

import { packInvite } from '@openvtc/vti-tsp-js'
import { diSign, diVerify, jcs, seal, type Json } from '@real-life/trust-protocol'
import { didWebvh } from '@openvtc/vti-didcomm-js'
import { ACK_TYPE, sealDoc } from '../zustellung'
import { classifyFrame, FRAME_CLASSES, PositiveList, type Classified, type FrameClass, type ListEntry } from './classifier'
import { E11bError, translate, type ErrorClass, type Stage } from './errors'
import { evaluateRow, probeOutcome, rowReceipts, resultTable, SenderLedger, stage1Needed, type AckCheck, type RecvEvent, type RowResult, type TableRow } from './evaluate'
import { BASELINE, DELETE_TO_ACK_FORMS, FORMS, FORM_IDS, STAGE1_FORMS, id, packForm, roles, type FormId } from './forms'
import { makeIdentityGroup, type IdentityGroup, type Side } from './identities'
import { summarizeMediator, type MediatorInfo, type ResolvedDoc, type RoutingVariant } from './mediator'
import { debugLine, envSummary, OBSERVE_MS, type LiveConfig } from './protocol'
import { SendRegistry, XrfiRegistry, type Dir, type Kind, type SendRecord } from './register'
import { Counters, liveMediatorPort, type MediatorPort, type PortSession, type ScopeCounters, type SessionLife } from './session'
import { cryptoRand, enc, hexOf, median, sha256hex, short8, type Rand } from './util'

export interface Versions {
  tsp: string
  didcomm: string
  trustProtocol: string
  node: string
}

export interface ProbeDeps {
  info: MediatorInfo
  port: MediatorPort
  counters: Counters
  rand?: Rand
  versions: Versions
  stderr?: (line: string) => void
  /** Post-observation window; the constant `OBSERVE_MS` unless a test shortens it. */
  observeMs?: number
  /** Test seams only (offline counterproofs); the live probe passes none. */
  hooks?: {
    beforeAckCheck?: () => Promise<void>
    /** Called synchronously when a settle starts, after its end of observation is fixed. */
    settling?: (phase: 'pass' | 'fresh' | 'final', group: string | null) => void
  }
}

export interface ProbeRun {
  /** Plain object; serialize only with `protocolJson`. */
  protocol: Record<string, unknown>
  failures: E11bError[]
  valid: boolean
}

class PreconditionAbort extends Error {
  constructor(readonly err: E11bError) {
    super('e11b precondition')
  }
}

/** Thrown inside a handler continuation after the probe was cancelled; the handler wrapper discards it. */
const CANCELLED = Symbol('e11b cancelled')

/** Upper bound on event-loop turns a settle waits for callbacks entering while it waits. */
const SETTLE_TURNS = 10_000

interface SideState {
  side: Side
  rel: 'AB' | 'AC'
  pos: 'x' | 'y'
  partner: SideState | null
  ledger: SenderLedger
  /** Digests whose effect (ack sent, ack checked) is done; handed to `receive()`. */
  completed: Set<string>
  /** Digests reserved synchronously before the first await of their effect (review 1 C2). */
  inflight: Set<string>
  listConn: PositiveList
  listEgress: PositiveList
  sessions: { conn?: PortSession; egress?: PortSession }
  fresh?: PortSession
}

/** In memory only: `ackCheck` is the check this ack receipt produced (review 1 C3). */
type GroupEvent = RecvEvent & { group: string; ackCheck?: AckCheck }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))
const iso = (t: number) => new Date(t).toISOString()

function variantView(v: RoutingVariant | null) {
  return v ? { firstHopVid: v.firstHopVid, methodRef: v.methodRef, x25519Fingerprint: short8(sha256hex(v.x25519)), sourceDocVersion: v.sourceDocVersion } : null
}

function countersView(scope: string, s: ScopeCounters) {
  const dir = (d: { socket: number; tspSocket: number; tspLogical: number }) => ({ ...d, rest: d.socket - d.tspSocket })
  return {
    scope,
    logins: s.logins,
    sockets: { opened: s.sockets.opened, maxConcurrent: s.sockets.maxConcurrent },
    bytes: { out: dir(s.bytes.out), in: dir(s.bytes.in) },
    frameErrors: s.frameErrors,
    didcomm: s.didcomm,
    problemCodes: s.problemCodes,
    consumerFailures: s.consumerFailures.length,
  }
}

export async function runProbe(cfg: LiveConfig, deps: ProbeDeps): Promise<ProbeRun> {
  const { info, port, counters } = deps
  const rand = deps.rand ?? cryptoRand
  const observeMs = deps.observeMs ?? OBSERVE_MS
  const timeoutMs = cfg.timeoutMs
  const now = () => Date.now()
  const t0 = now()
  const rt = (t: number) => t - t0

  // Output archives over all passes. Matching uses per-pass registers (draft 3 §3.2: discarded
  // before the next pass), created in `runFormPass`.
  const archive = new SendRegistry()
  const xrfiArchive = new XrfiRegistry()
  const events: GroupEvent[] = []
  const freshEvents: Array<{ group: string; socket: string; recordId: string | null; cls: FrameClass; kind: 'redelivered' | 'first-in-fresh' | 'unassigned'; tMs: number }> = []
  const unassigned: Array<{ group: string; socket: string; size: number; cls: FrameClass; tMs: number }> = []
  const controls: Array<{ group: string; socket: string; controlType: string; correlation: string; signatureMethod: string | null; tMs: number }> = []
  const ackChecks = new Map<string, AckCheck>()
  const classCounts: Record<string, number> = Object.fromEntries(FRAME_CLASSES.map((c) => [c, 0]))
  const rows: RowResult[] = []
  const rowClosedAt = new Map<string, number>()
  const groups: Array<Record<string, unknown>> = []
  const notes: Array<{ kind: string; form: FormId | null; cls: string | null }> = []
  const cells: Array<{ form: FormId; stage: 0 | 1 }> = []
  const failures: E11bError[] = []
  let anySessionOk = false
  let precondition: E11bError | null = null
  const afterCloseEvents: Array<{ group: string; socket: string; session: 'main' | 'fresh'; recordId: string | null; cls: FrameClass; tMs: number }> = []

  // ── callbacks in flight (review 1 C1, review 2 C1, review 3 C1, review 4 C1) ──
  // Every accepted callback is tracked: the TSP handlers, and through `SessionLife` the processing
  // of every inbound frame in the session (DIDComm unpack, status and problem-report counters,
  // frame errors) and every pickup ack, also those the library starts detached. A pass closes its
  // sockets and the probe takes its snapshot only after all of them settled. After the snapshot
  // (`finished`) callbacks do nothing. A settle that runs out of time cancels the probe:
  // `cancelled` is checked by every TSP callback before each state change and each transport
  // effect, and by the session before each counter change and before sending a pickup ack, so a
  // callback still running after the cancel changes nothing and sends nothing; its late failure
  // is discarded (the run is already invalid with `settle-timeout`). The cancelled pass is still
  // evaluated (review 3 C2); no later pass starts.
  let finished = false
  let cancelled = false
  const pending = new Set<Promise<void>>()
  const track = (p: Promise<void>): Promise<void> => {
    const guarded = p.catch((e: unknown) => {
      // Discarded on purpose: after the cancel nothing may reach the counters or the failure list.
      if (cancelled || e === CANCELLED) return
      throw e
    })
    pending.add(guarded)
    const done = () => void pending.delete(guarded)
    guarded.then(done, done)
    return guarded
  }
  /** The session side of the same lifecycle (review 3 C1). */
  const life: SessionLife = {
    track: (p) => {
      const quiet = p.then(
        () => undefined,
        () => undefined,
      )
      pending.add(quiet)
      void quiet.then(() => pending.delete(quiet))
    },
    accepting: () => !cancelled && !finished,
  }
  /** Throws `CANCELLED` once the probe was cancelled; called before every state change or effect. */
  const live = () => {
    if (cancelled) throw CANCELLED
  }
  const settleTimeout = new E11bError('probe', 'settle-timeout')
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    failures.push(settleTimeout)
  }
  /**
   * Wait until no callback is in flight and none entered during one full event-loop turn
   * (bounded by the delivery window and `SETTLE_TURNS`). The turn also lets a session wrapper
   * record a consumer exception before `close()` collects it. Running out of time or turns cancels
   * the probe; the caller still evaluates what it has (review 3 C2).
   */
  const settle = async (phase: 'pass' | 'fresh' | 'final', group: string | null) => {
    if (cancelled) return
    deps.hooks?.settling?.(phase, group)
    const deadline = now() + timeoutMs
    for (let turn = 0; turn < SETTLE_TURNS; turn++) {
      while (pending.size > 0 && now() < deadline) await Promise.race([Promise.allSettled([...pending]), sleep(deadline - now())])
      if (pending.size > 0) break
      await new Promise<void>((r) => setImmediate(r))
      if (pending.size === 0) return
    }
    cancel()
  }

  // ── waiting ──
  const waiters = new Set<() => void>()
  const notify = () => {
    for (const w of [...waiters]) w()
  }
  const waitFor = (pred: () => boolean, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (pred()) return resolve(true)
      const check = () => {
        if (pred()) {
          waiters.delete(check)
          clearTimeout(timer)
          resolve(true)
        }
      }
      const timer = setTimeout(() => {
        waiters.delete(check)
        resolve(pred())
      }, Math.max(0, ms))
      waiters.add(check)
    })

  const debug = (kind: 'row' | 'error', v: unknown) => {
    if (cfg.debug && deps.stderr) deps.stderr(debugLine(kind, v))
  }

  // ── end of a run: one path for timeout and error (#78) ──
  // A pass that started is always closed and evaluated with what it has, whether it ended normally,
  // by a settle timeout (`cancelled`) or by an error (`fatal`): settle, close, rows, group. Then no
  // further pass starts (no fresh session, no later form, no stage 1).
  let fatal: E11bError | null = null
  /** Records an error as an invalid run; the first one is `result.error`. Never throws. */
  const abort = (e: unknown, stage: Stage) => {
    const err = translate(e, stage)
    failures.push(err)
    fatal ??= err
    try {
      debug('error', err)
    } catch {
      // Debug output only; the error itself is already recorded.
    }
  }
  const stopped = () => cancelled || fatal !== null

  async function runFormPass(form: FormId, stage: 0 | 1) {
    const spec = FORMS[form]
    const variant = spec.prime ? info.prime! : info.routing
    const groupId = `${form}/s${stage}`
    counters.current = groupId
    const group: IdentityGroup = await makeIdentityGroup(groupId, info.did, rand)
    const registry = new SendRegistry()
    const xrfi = new XrfiRegistry()
    cells.push({ form, stage })

    const mediatorEntry = (receiver: { did: string; xSecret: Uint8Array }): ListEntry => ({ sender: info.did, receiver: receiver.did, signing: info.edCandidates, receiverSecret: receiver.xSecret, allowed: new Set(['control']) })
    const states: SideState[] = []
    for (const r of group.rels) {
      const mk = (s: Side, partnerSide: Side, pos: 'x' | 'y'): SideState => {
        const peerInner = id(partnerSide, spec.inner)
        return {
          side: s,
          rel: r.id,
          pos,
          partner: null,
          ledger: new SenderLedger(partnerSide.party.anchor, timeoutMs),
          completed: new Set(),
          inflight: new Set(),
          listConn: new PositiveList([
            { sender: peerInner.did, receiver: s.conn.did, signing: [{ ref: 'peer', pub: peerInner.edPublic }], receiverSecret: s.conn.xSecret, allowed: new Set(['direct']) },
            mediatorEntry(s.conn),
          ]),
          listEgress: new PositiveList([mediatorEntry(s.egress)]),
          sessions: {},
        }
      }
      const x = mk(r.x, r.y, 'x')
      const y = mk(r.y, r.x, 'y')
      x.partner = y
      y.partner = x
      states.push(x, y)
    }
    let lastSend = now()

    async function send(from: SideState, kind: Kind, payload: Uint8Array, meta: { dir: Dir; run: number; docRow?: string; recordId: string }): Promise<SendRecord> {
      const to = from.partner!
      let packed
      try {
        packed = await packForm(spec, variant, from.side, to.side, payload)
      } catch (e) {
        throw translate(e, 'send')
      }
      live()
      const rec: SendRecord = {
        id: meta.recordId,
        group: groupId,
        form,
        stage,
        rel: from.rel,
        dir: meta.dir,
        run: meta.run,
        kind,
        payloadDigest: sha256hex(payload),
        innerDigest: sha256hex(packed.inner.bytes),
        outerDigest: packed.outer ? sha256hex(packed.outer.bytes) : null,
        sizes: { payload: payload.length, inner: packed.inner.bytes.length, outer: packed.outer ? packed.outer.bytes.length : null, wire: packed.wire.length },
        tSend: now(),
        receiverSocket: `${to.side.label}.conn`,
        ...(meta.docRow ? { docRow: meta.docRow } : {}),
      }
      registry.add(rec)
      archive.add(rec)
      const session = from.sessions[spec.socket]
      if (!session) throw new E11bError('send', 'other')
      session.sendBinary(packed.wire)
      lastSend = rec.tSend
      return rec
    }

    async function sendAck(receiver: SideState, docRecord: SendRecord, c: Classified) {
      const doc = c.received!.document as { threadId: string }
      const sender = receiver.partner!
      const ackDoc = await diSign(
        { anchor: receiver.side.party.anchor, ed: { priv: receiver.side.party.ed.priv } },
        { id: crypto.randomUUID(), type: ACK_TYPE, issuer: receiver.side.party.anchor, recipient: sender.side.party.anchor, threadId: doc.threadId, issuedAt: iso(now()), payload: { ref: c.received!.digest!, meaning: 'received' } },
        iso(now()),
      )
      const ackEnv = await seal(ackDoc as unknown as Json, sender.side.party.rkid)
      live()
      await send(receiver, 'ack', enc.encode(jcs(ackEnv)), { dir: docRecord.dir === 'x2y' ? 'y2x' : 'x2y', run: docRecord.run, docRow: docRecord.id, recordId: `${docRecord.id}/ack` })
    }

    // End of observation (review 1 C1): `closedAt` (main sessions) and `freshClosedAt` (fresh
    // delete-to-ack sessions) are fixed acceptance deadlines. A callback entering after the deadline
    // was fixed is only listed as `after-close`: no counters, no transitions, no acks, no pickup ack.
    let closedAt: number | null = null
    let freshClosedAt: number | null = null
    const classify = (st: SideState, which: 'conn' | 'egress', socket: string, qb2: Uint8Array) =>
      classifyFrame(qb2, {
        list: which === 'conn' ? st.listConn : st.listEgress,
        registry,
        xrfi,
        socket,
        resolve: (rkid) => (rkid === st.side.party.rkid ? st.side.party.x.priv : undefined),
        completed: st.completed,
      })
    const afterClose = async (st: SideState, which: 'conn' | 'egress', fresh: boolean, qb2: Uint8Array, t: number) => {
      const socket = `${st.side.label}.${which}`
      try {
        const c = await classify(st, which, socket, qb2)
        live()
        afterCloseEvents.push({ group: groupId, socket, session: fresh ? 'fresh' : 'main', recordId: c.recordId ?? null, cls: c.cls, tMs: rt(t) })
        // Main-session receipts after close also appear in the record's receipt list, as not counted (C3).
        if (!fresh && c.recordId) events.push({ group: groupId, socket, size: c.size, cls: c.cls, t, fresh: false, afterClose: true, recordId: c.recordId, ...(c.verdict ? { verdict: c.verdict } : {}) })
      } catch (e) {
        if (e === CANCELLED || cancelled) return
        failures.push(translate(e, 'classify'))
      }
    }
    const handler = (st: SideState, which: 'conn' | 'egress', fresh: boolean) => (qb2: Uint8Array, text: string) => {
      const t = now()
      if (finished || cancelled) return Promise.resolve()
      // Closed once the deadline is fixed: a callback entering in the same millisecond as `closedAt`,
      // but after it was fixed, is after-close too (review 2 C1).
      const end = fresh ? freshClosedAt : closedAt
      return track(end !== null ? afterClose(st, which, fresh, qb2, t) : handle(st, which, fresh, qb2, text, t))
    }
    const handle = async (st: SideState, which: 'conn' | 'egress', fresh: boolean, qb2: Uint8Array, text: string, t: number) => {
      const socket = `${st.side.label}.${which}`
      const session = fresh ? st.fresh : st.sessions[which]
      const c = await classify(st, which, socket, qb2)
      live()
      classCounts[c.cls] = (classCounts[c.cls] ?? 0) + 1
      // Reservation (review 1 C2): two copies classified concurrently both get `unique` from
      // receive(), since `completed` grows only after the effect. The first copy reserves the
      // digest synchronously, before any await; every later copy is `duplicate-known`.
      // Probe simplification: a duplicate gets no second ack. Delivery §6.2 would send the kept
      // ack again; the probe measures the first delivery and its ack only.
      const digest = c.received?.digest
      if (!fresh && (c.cls === 'doc' || c.cls === 'ack') && c.verdict === 'unique' && digest) {
        if (st.inflight.has(digest) || st.completed.has(digest)) c.verdict = 'duplicate-known'
        else st.inflight.add(digest)
      }
      if (fresh) {
        // Observation only: no contract transitions, no acks (C1); the pickup ack cleans the queue.
        const earlier = c.recordId !== undefined && events.some((e) => e.recordId === c.recordId)
        live()
        freshEvents.push({ group: groupId, socket, recordId: c.recordId ?? null, cls: c.cls, kind: c.recordId === undefined ? 'unassigned' : earlier ? 'redelivered' : 'first-in-fresh', tMs: rt(t) })
        await session?.ack(text)
        return
      }
      const ev: GroupEvent = { group: groupId, socket, size: c.size, cls: c.cls, t, fresh: false, ...(c.recordId ? { recordId: c.recordId } : {}), ...(c.verdict ? { verdict: c.verdict } : {}), ...(c.layer ? { layer: c.layer } : {}), ...(c.hopsLength !== undefined ? { hopsLength: c.hopsLength } : {}) }
      events.push(ev)
      if (c.controlType) controls.push({ group: groupId, socket, controlType: c.controlType, correlation: c.correlation ?? 'none', signatureMethod: c.signatureMethod ?? null, tMs: rt(t) })
      else if (!c.recordId) unassigned.push({ group: groupId, socket, size: c.size, cls: c.cls, tMs: rt(t) })
      const rec = c.recordId ? registry.get(c.recordId) : undefined
      if (c.cls === 'doc' && c.verdict === 'unique' && c.received && rec?.kind === 'doc' && rec.group === groupId) {
        const proofOk = await diVerify(c.received.document, st.partner!.side.party.anchor)
        live()
        if (!proofOk) ev.verdict = 'proof-invalid'
        else {
          st.partner!.ledger.docReceived(c.received.digest!, t)
          await sendAck(st, rec, c)
          live()
          st.completed.add(c.received.digest!)
        }
      }
      if (c.cls === 'ack' && c.received) {
        await deps.hooks?.beforeAckCheck?.()
        live()
        // The ledger transition is guarded too: it happens only while the probe is not cancelled.
        const checked: AckCheck = c.verdict === 'unique' ? await st.ledger.checkAck(c.received, t, false, () => !cancelled) : { valid: false, inTime: false, reason: 'not-unique', t }
        live()
        // Receipt time `t` (handler entry) and end of verification are separate (review 1 C4).
        const chk: AckCheck = { ...checked, tVerified: now() }
        ev.ackCheck = chk
        if (chk.rowId) {
          const prev = ackChecks.get(chk.rowId)
          if (!prev || (!prev.valid && chk.valid)) ackChecks.set(chk.rowId, chk)
        }
        if (chk.valid) st.completed.add(c.received.digest!)
      }
      // Pickup ack only after the frame was handled (conclude).
      live()
      await session?.ack(text)
      notify()
    }

    const closeAll = () => {
      for (const st of states) {
        st.sessions.conn?.close()
        st.sessions.egress?.close()
        st.fresh?.close()
      }
    }
    const open = async (st: SideState, which: 'conn' | 'egress', fresh: boolean) => {
      const s = await port.open(which === 'conn' ? st.side.conn : st.side.egress, `${st.side.label}.${which}`, handler(st, which, fresh), life)
      anySessionOk = true
      return s
    }

    try {
      for (const st of states) {
        st.sessions.conn = await open(st, 'conn', false)
        if (spec.socket === 'egress') st.sessions.egress = await open(st, 'egress', false)
      }
    } catch (e) {
      closeAll()
      const err = translate(e, 'login')
      if (!anySessionOk) throw new PreconditionAbort(err)
      notes.push({ kind: 'form-aborted', form, cls: err.cls })
      debug('error', err)
      return
    }

    try {
      if (stage === 1) {
        for (const st of states) {
          const inv = await packInvite(st.side.conn.did, info.did, { senderSigningKey: st.side.conn.edSecret, receiverEncryptionKey: info.routing.x25519 })
          const entry = { group: groupId, socket: `${st.side.label}.conn`, threadDigest: hexOf(inv.threadDigest), tSend: now() }
          xrfi.add(entry)
          xrfiArchive.add(entry)
          st.sessions.conn!.sendBinary(inv.bytes)
          lastSend = now()
        }
        await waitFor(() => states.every((st) => controls.some((c) => c.group === groupId && c.socket === `${st.side.label}.conn` && c.correlation === 'own-xrfi')), timeoutMs)
      }
      const firstOk = (rid: string, cls: FrameClass) => events.some((e) => e.recordId === rid && e.cls === cls && (cls !== 'doc' || e.verdict === 'unique'))
      for (let run = 1; run <= cfg.runs; run++) {
        for (const r of group.rels) {
          for (const dir of ['x2y', 'y2x'] as const) {
            const S = states.find((s) => s.rel === r.id && s.pos === (dir === 'x2y' ? 'x' : 'y'))!
            const R = S.partner!
            const base = `${groupId}/${r.id}/${dir}/r${run}`
            const probe = await send(S, 'probe', rand(64), { dir, run, recordId: `${base}/probe` })
            await waitFor(() => firstOk(probe.id, 'probe'), timeoutMs)
            const threadId = crypto.randomUUID()
            const { digest, bytes } = await sealDoc(S.side.party, R.side.party, { note: 'e11b live probe', run, rel: r.id, dir }, threadId)
            S.ledger.submit(`${base}/doc`, digest, threadId)
            const doc = await send(S, 'doc', bytes, { dir, run, recordId: `${base}/doc` })
            if (await waitFor(() => firstOk(doc.id, 'doc'), timeoutMs)) {
              const tDoc = events.find((e) => e.recordId === doc.id && e.cls === 'doc' && e.verdict === 'unique')!.t
              await waitFor(() => ackChecks.get(doc.id)?.valid === true, tDoc + timeoutMs - now())
            }
          }
        }
      }
      // Post-observation from the last send of the pass; later acks do not extend it.
      await sleep(lastSend + observeMs - now())
    } catch (e) {
      // A send, pack or other failure ends the run, not the pass: it is closed and evaluated below.
      if (e !== CANCELLED) abort(e, 'probe')
    } finally {
      // Fix the deadline, let accepted callbacks finish (they may still send acks), then close.
      closedAt = now()
      try {
        await settle('pass', groupId)
      } finally {
        closeAll()
      }
    }
    const passClosedAt = closedAt

    // A stopped pass (timeout or error) skips its fresh session and is evaluated with what it has
    // (review 3 C2, #78).
    if (stage === 0 && DELETE_TO_ACK_FORMS.includes(form) && !stopped()) {
      try {
        for (const st of states) st.fresh = await open(st, 'conn', true)
        await sleep(observeMs)
      } catch (e) {
        notes.push({ kind: 'form-aborted', form, cls: translate(e, 'login').cls })
      } finally {
        freshClosedAt = now()
        try {
          await settle('fresh', groupId)
        } finally {
          for (const st of states) st.fresh?.close()
        }
      }
    }

    // Each row and the group description on their own: a failure there is recorded (invalid run, no
    // further pass), and every other row of the pass is still evaluated (#78).
    for (const rec of registry.all()) {
      if (rec.group !== groupId || rec.kind === 'ack') continue
      try {
        // Provisional `receipts`: the exported list is rebuilt from the final events at the snapshot (review 2 C2).
        const row = evaluateRow(rec, events, ackChecks.get(rec.id), { timeoutMs, closedAt: passClosedAt })
        rowClosedAt.set(rec.id, passClosedAt)
        rows.push(row)
        debug('row', rowView(row, rec))
      } catch (e) {
        abort(e, 'probe')
      }
    }

    try {
      const sideOf = (st: SideState) => st.side
      groups.push({
        id: groupId,
        form,
        stage,
        identities: states.flatMap((st) => [
          { label: `${st.side.label}.conn`, did: st.side.conn.did },
          { label: `${st.side.label}.egress`, did: st.side.egress.did },
        ]),
        roles: states.map((st) => ({ side: st.side.label, ...roles(spec, sideOf(st)) })),
        equalities: { innerIsSocket: spec.inner === spec.socket, outerIsSocket: spec.outer ? spec.outer === spec.socket : null, innerIsConnection: spec.inner === 'conn' },
        linkableAcrossRelationships: linkable(states),
        peerSees: states.map((st) => ({ side: st.side.label, dids: [`${st.side.label}.${spec.inner}`], includesConnection: spec.inner === 'conn' })),
        sessionsPerRelationship: { sender: spec.senderSessions, receiver: 1 },
      })
    } catch (e) {
      abort(e, 'probe')
    }
  }

  function rowView(r: RowResult, rec: SendRecord) {
    // Counted receipts only: a receipt after close is listed in `receipts`, never as the received size.
    const first = events.filter((e) => e.recordId === rec.id && !e.fresh && !e.afterClose).sort((a, b) => a.t - b.t)[0]
    return {
      ...r,
      digests: { payload: short8(rec.payloadDigest), inner: short8(rec.innerDigest), outer: rec.outerDigest ? short8(rec.outerDigest) : null },
      bytes: { ...rec.sizes, received: first ? first.size : null },
    }
  }

  try {
    for (const form of FORM_IDS) {
      if (!cfg.forms.includes(form)) continue
      if (form === "R-c'" && !info.prime) {
        notes.push({ kind: 'prime-not-measured', form, cls: info.primeNote })
        continue
      }
      await runFormPass(form, 0)
      if (stopped()) break
    }
    const table0 = resultTable(rows, cells)
    // No further pass after a settle timeout or an error (review 3 C2, #78); `result.error` names it.
    if (stopped()) {
      /* no stage 1 */
    } else if (stage1Needed(table0)) {
      const todo = STAGE1_FORMS.filter((f) => cfg.forms.includes(f))
      if (todo.length) notes.push({ kind: 'stage1-run', form: null, cls: null })
      for (const f of todo) {
        await runFormPass(f, 1)
        if (stopped()) break
      }
    } else notes.push({ kind: 'stage1-not-needed', form: null, cls: null })
  } catch (e) {
    if (e instanceof PreconditionAbort) precondition = e.err
    else abort(e, 'probe')
  }

  // Snapshot (review 1 C1, review 2 C1): no callback in flight over a full event-loop turn, later
  // ones are ignored; after a cancel the remaining callbacks are inert.
  await settle('final', null)
  if (cancelled) fatal ??= settleTimeout
  finished = true
  const total = counters.total()
  for (const cls of total.consumerFailures) failures.push(new E11bError('consumer', cls))
  if (total.consumerFailures.length) notes.push({ kind: 'consumer-failure', form: null, cls: total.consumerFailures[0] ?? null })

  const table: TableRow[] = resultTable(rows, cells)
  const routedRows = rows.filter((r) => r.form.startsWith('R-'))
  const keyBinding = routedRows.length === 0 ? 'not-applicable' : routedRows.some((r) => r.opened) ? 'confirmed' : 'unclear'
  if (keyBinding === 'unclear') notes.push({ kind: 'key-binding-unclear', form: null, cls: null })
  const baseline: Array<{ form: FormId; expected: string; observed: string }> = []
  for (const [form, expected] of Object.entries(BASELINE) as Array<[FormId, string]>) {
    const cell = table.find((r) => r.form === form && r.stage === 0)
    if (!cell) continue
    baseline.push({ form, expected, observed: cell.transport.outcome })
    if (cell.transport.outcome !== expected) notes.push({ kind: 'baseline-deviation', form, cls: null })
  }
  const outcome = probeOutcome({ preconditionFailed: precondition !== null, forms: cfg.forms, table })

  const costs = cells.map(({ form, stage }) => {
    const recs = archive.all().filter((r) => r.form === form && r.stage === stage)
    // Every send of a kind, min / median / max per layer (review 1 H1); null when the kind was not sent.
    const sizeOf = (k: Kind) => {
      const ofKind = recs.filter((r) => r.kind === k)
      if (ofKind.length === 0) return null
      const stat = (xs: number[]) => ({ min: Math.min(...xs), median: median(xs), max: Math.max(...xs) })
      const outer = ofKind.map((r) => r.sizes.outer).filter((x): x is number => x !== null)
      return { n: ofKind.length, payload: stat(ofKind.map((r) => r.sizes.payload)), inner: stat(ofKind.map((r) => r.sizes.inner)), outer: outer.length ? stat(outer) : null, wire: stat(ofKind.map((r) => r.sizes.wire)) }
    }
    const mine = rows.filter((r) => r.form === form && r.stage === stage)
    const oneWay = mine.filter((r) => r.kind === 'probe' && r.outcome !== 'not-shown' && r.tRecvMs !== null).map((r) => r.tRecvMs!)
    const ackRecv = mine.filter((r) => r.kind === 'doc' && r.ackValid && r.tAckReceivedMs !== null).map((r) => r.tAckReceivedMs!)
    // Round trip document → ack verified (review 1 C4).
    const round = mine.filter((r) => r.kind === 'doc' && r.ackValid && r.tAckVerifiedMs !== null).map((r) => r.tAckVerifiedMs!)
    return {
      form,
      stage,
      sizes: { probe: sizeOf('probe'), doc: sizeOf('doc'), ack: sizeOf('ack') },
      oneWayMs: { median: median(oneWay), max: oneWay.length ? Math.max(...oneWay) : null, n: oneWay.length },
      ackReceivedMs: { median: median(ackRecv), max: ackRecv.length ? Math.max(...ackRecv) : null, n: ackRecv.length },
      roundTripMs: { median: median(round), max: round.length ? Math.max(...round) : null, n: round.length },
    }
  })

  const acks = archive
    .all()
    .filter((r) => r.kind === 'ack')
    .map((r) => {
      const chk = r.docRow ? ackChecks.get(r.docRow) : undefined
      const mine = events.filter((e) => e.recordId === r.id).sort((a, b) => a.t - b.t)
      // `received*` describe the first receipt within the observation; `receipts` lists all (C3).
      const ev = mine.find((e) => !e.afterClose)
      const receipts = mine.map((e) => ({ tMs: e.t - r.tSend, cls: e.cls, socket: e.socket, verdict: e.verdict ?? null, counted: !e.afterClose, picked: chk !== undefined && e.ackCheck === chk, check: e.ackCheck?.reason ?? null }))
      return {
        id: r.id,
        docRow: r.docRow,
        form: r.form,
        stage: r.stage,
        digests: { payload: short8(r.payloadDigest), inner: short8(r.innerDigest), outer: r.outerDigest ? short8(r.outerDigest) : null },
        bytes: r.sizes,
        tSendMs: rt(r.tSend),
        received: Boolean(ev),
        receivedClass: ev?.cls ?? null,
        tRecvMs: ev ? ev.t - r.tSend : null,
        check: chk?.reason ?? null,
        inTime: chk ? chk.inTime : null,
        receipts,
      }
    })

  const protocol = {
    schema: 'e11b-live/2',
    head: headOf(cfg, deps.versions, t0, observeMs, info, keyBinding),
    groups,
    // Receipt lists from the final event set (review 2 C2), not from the pass evaluation.
    rows: rows.map((r) => {
      const rec = archive.get(r.id)!
      return { ...rowView(r, rec), receipts: rowReceipts(rec, events, rowClosedAt.get(r.id)!) }
    }),
    acks,
    controls,
    xrfi: xrfiArchive.all().map((x) => ({ group: x.group, socket: x.socket, threadDigest: short8(x.threadDigest), tSendMs: rt(x.tSend) })),
    events: { unassigned, fresh: freshEvents, afterClose: afterCloseEvents },
    counters: { classes: classCounts, perScope: [...counters.scopes.entries()].map(([k, s]) => countersView(k, s)), total: countersView('total', total) },
    costs,
    result: { table, outcome, error: precondition ? { stage: precondition.stage, cls: precondition.cls } : fatal ? { stage: fatal.stage, cls: fatal.cls } : null, notes, baseline, valid: failures.length === 0 },
  }
  // A deep copy: nothing that still holds a reference to the probe's state can change the result.
  return { protocol: structuredClone(protocol), failures: [...failures], valid: failures.length === 0 }
}

function linkable(states: SideState[]): boolean {
  const didsOf = (label: string) => states.filter((s) => s.side.label === label).flatMap((s) => [s.side.conn.did, s.side.egress.did])
  const ab = new Set(didsOf('A.AB'))
  return didsOf('A.AC').some((d) => ab.has(d))
}

function headOf(cfg: LiveConfig, versions: Versions, t0: number, observeMs: number, info: MediatorInfo | null, keyBinding: string) {
  return {
    date: iso(t0),
    mediatorDid: cfg.mediatorDid,
    versionId: info?.versionId ?? 'invalid',
    wsHost: info?.wsHost ?? 'invalid',
    services: info?.services ?? [],
    methods: info?.methods ?? [],
    routing: { default: info ? variantView(info.routing) : null, prime: info ? variantView(info.prime) : null, primeNote: info?.primeNote ?? 'no-tsp-service' },
    versions,
    env: envSummary(cfg),
    observeMs,
    keyBinding,
  }
}

/** Protocol of a probe that could not start (draft 3 §6.3 branch 1). */
export function preconditionProtocol(cfg: LiveConfig, versions: Versions, err: E11bError): ProbeRun {
  const t0 = Date.now()
  return {
    protocol: {
      schema: 'e11b-live/2',
      head: headOf(cfg, versions, t0, OBSERVE_MS, null, 'not-applicable'),
      groups: [],
      rows: [],
      acks: [],
      controls: [],
      xrfi: [],
      events: { unassigned: [], fresh: [], afterClose: [] },
      counters: { classes: {}, perScope: [], total: countersView('total', new Counters().total()) },
      costs: [],
      result: { table: [], outcome: 'precondition-failed', error: { stage: err.stage, cls: err.cls }, notes: [], baseline: [], valid: true },
    },
    failures: [],
    valid: true,
  }
}

export interface LiveOptions {
  versions: Versions
  rand?: Rand
  stderr?: (line: string) => void
  fetch?: typeof fetch
  WebSocketImpl?: ConstructorParameters<typeof Object>[0]
  /** did:webvh resolution (default: `didWebvh.resolve` with the net policy). */
  resolveWebvh?: (did: string) => Promise<ResolvedDoc>
  observeMs?: number
}

/** The live probe: resolve the mediator document, then run all forms against the live mediator. */
export async function runLiveProbe(cfg: LiveConfig, opts: LiveOptions): Promise<ProbeRun> {
  const netPolicy = cfg.allowInsecure ? { allowInsecure: true, allowPrivate: true } : undefined
  const resolveWebvh =
    opts.resolveWebvh ??
    (async (d: string) => {
      const r = await didWebvh.resolve(d, netPolicy ? { netPolicy } : {})
      return r as unknown as ResolvedDoc
    })
  let info: MediatorInfo
  try {
    info = await summarizeMediator(cfg.mediatorDid, await resolveWebvh(cfg.mediatorDid), resolveWebvh, netPolicy)
  } catch (e) {
    return preconditionProtocol(cfg, opts.versions, translate(e, 'resolve'))
  }
  const counters = new Counters()
  const port = liveMediatorPort(info, { counters, ...(netPolicy ? { netPolicy } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl as never } : {}) })
  return runProbe(cfg, { info, port, counters, versions: opts.versions, ...(opts.rand ? { rand: opts.rand } : {}), ...(opts.stderr ? { stderr: opts.stderr } : {}), ...(opts.observeMs !== undefined ? { observeMs: opts.observeMs } : {}) })
}

export type { Stage, ErrorClass }
