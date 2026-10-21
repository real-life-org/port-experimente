// Safe error translation (E11b draft 3 §9, review 3 C6). A caught exception is
// never serialized, printed or rethrown as is: it becomes an `E11bError` that
// carries only a stage and a class from a fixed list, without `cause`.

export const ERROR_CLASSES = ['timeout', 'ws-closed', 'auth-refused', 'http-4xx', 'http-5xx', 'resolve-failed', 'unpack-failed', 'seal-failed', 'other'] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]

export const STAGES = ['config', 'resolve', 'login', 'socket', 'send', 'classify', 'consumer', 'gate', 'probe', 'write'] as const
export type Stage = (typeof STAGES)[number]

export class E11bError extends Error {
  constructor(
    readonly stage: Stage,
    readonly cls: ErrorClass,
  ) {
    super(`e11b ${stage}: ${cls}`)
    this.name = 'E11bError'
  }
}

function field(e: unknown, key: string): unknown {
  return typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[key] : undefined
}

/** Classify an exception. Reads status, code and name; the message only for a timeout pattern. Never returns text from the error. */
export function errorClass(e: unknown, stage: Stage): ErrorClass {
  if (e instanceof E11bError) return e.cls
  const status = field(e, 'status')
  if (typeof status === 'number') {
    if (stage === 'login' && (status === 401 || status === 403)) return 'auth-refused'
    if (status >= 400 && status < 500) return 'http-4xx'
    if (status >= 500 && status < 600) return 'http-5xx'
  }
  const name = field(e, 'name')
  const msg = e instanceof Error ? e.message : ''
  if (name === 'TimeoutError' || /time(d)? ?out|no open\/close within/i.test(msg)) return 'timeout'
  if (stage === 'socket') return field(e, 'code') === 1008 ? 'auth-refused' : 'ws-closed'
  if (stage === 'resolve') return 'resolve-failed'
  if (stage === 'login') return /access_token|challenge/.test(msg) ? 'auth-refused' : 'other'
  if (stage === 'classify') return 'unpack-failed'
  if (stage === 'send') return 'seal-failed'
  return 'other'
}

/** The only form in which an exception leaves the probe: stage and class, nothing else. */
export function translate(e: unknown, stage: Stage): E11bError {
  if (e instanceof E11bError) return new E11bError(e.stage, e.cls)
  return new E11bError(stage, errorClass(e, stage))
}
