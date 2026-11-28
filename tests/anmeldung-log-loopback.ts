// Tests only: a way to send for the wallet that reaches https://<name>.localhost:<port>
// over plain http on 127.0.0.1 at the same port. It sits behind the same rules
// as the default transport (`limited`: size cap, time limit, no redirect);
// only the connection differs. The shipped module has no such path.

import { request } from 'node:http'
import { limited, type Send, type Transport } from '../src/lab/anmeldung-log/transport'

export const loopbackSend: Send = (url, r) => new Promise((ok, fail) => {
  const host = url.hostname.toLowerCase()
  if (host !== 'localhost' && !host.endsWith('.localhost')) { fail(new Error('the test transport reaches only *.localhost')); return }
  const req = request({ host: '127.0.0.1', port: url.port, path: url.pathname + url.search, method: r.method, headers: r.headers, signal: r.signal }, (res) => {
    ok({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: res })
  })
  req.on('error', fail)
  req.end(r.body)
})

export const loopbackTransport = (o: { timeoutMs?: number } = {}): Transport => limited(loopbackSend, o)

/**
 * A transport that keeps what the wallet posts instead of sending it, so a
 * test can deliver the answer itself (to another attempt, or at another
 * moment). The wallet still goes its whole way, gate included; fetching
 * goes through `inner`.
 */
export function holding (inner: Transport): { transport: Transport, held: { url: string, form: Record<string, string> }[] } {
  const held: { url: string, form: Record<string, string> }[] = []
  return {
    held,
    transport: {
      get: (url, o) => inner.get(url, o),
      post: async (url, body) => { held.push({ url, form: Object.fromEntries(new URLSearchParams(body)) }); return { status: 0, type: '', text: '' } },
    },
  }
}
