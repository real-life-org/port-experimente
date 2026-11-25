// The demo wallet in the browser: stands in for the Web of Trust app until
// step 3. It reads the request from the URL fragment, shows what the app would
// show, signs with a test identity kept only in this browser, posts the answer
// and, for a same-device request, opens the web app's return address.

import { b64uOf, fromB64u, anchorOfEd } from 'rltp-lib'
import { parseRequestUrl } from './siop'
import { confirm, loginKey, mayOpen, review } from './wallet'

const STORE = 'anmeldung-test-wurzel'

function testRoot (): Uint8Array {
  try {
    const kept = localStorage.getItem(STORE)
    if (kept) return fromB64u(kept)
    const fresh = crypto.getRandomValues(new Uint8Array(32))
    localStorage.setItem(STORE, b64uOf(fresh))
    return fresh
  } catch { return crypto.getRandomValues(new Uint8Array(32)) }
}

const app = document.getElementById('app')!
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e
}
const say = (...nodes: Node[]): void => { app.replaceChildren(...nodes) }

async function main (): Promise<void> {
  const req = parseRequestUrl(decodeURIComponent(location.hash.slice(1)))
  if (!req) { say(el('p', 'Keine Anmeldeanfrage. Diese Seite öffnet sich über den Code oder Link einer Web-App.')); return }
  const shown = review(req)
  if (!shown.ok) { say(el('p', `Anmeldung abgelehnt: ${shown.reason}.`)); return }
  const root = testRoot()
  const did = anchorOfEd((await loginKey(root, req.client_id)).pubRaw)

  const host = el('strong', shown.host)
  const text = el('p'); text.append(host, document.createTextNode(shown.text.slice(shown.host.length)))
  const label = el('label', 'Namen mitschicken (freiwillig)')
  const name = el('input'); name.id = 'name'; name.autocomplete = 'name'; label.append(name)
  const yes = el('button', 'Anmelden'), no = el('button', 'Abbrechen', 'secondary')
  const row = el('div', undefined, 'row'); row.append(yes, no)
  const small = el('p', `Dein Name dort: ${did.slice(0, 20)}…`, 'muted')
  say(text, label, row, small)

  no.onclick = () => say(el('p', 'Abgebrochen. Es wurde nichts gesendet.'))
  yes.onclick = async () => {
    yes.disabled = true; no.disabled = true
    try {
      const answer = await confirm(req, root, Date.now(), { name: name.value.trim() || undefined })
      const r = await fetch(answer.response_uri, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(answer.body).toString() })
      if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) { say(el('p', 'Die Web-App hat umgeleitet. Aus Sicherheitsgründen wurde abgebrochen.')); return }
      const body = await r.json().catch(() => ({})) as { redirect_uri?: string, error_description?: string }
      if (!r.ok) { say(el('p', `Die Web-App hat abgelehnt: ${body.error_description ?? r.status}.`)); return }
      if (typeof body.redirect_uri === 'string') {
        if (!mayOpen(req, body.redirect_uri)) { say(el('p', 'Die Rücksprungadresse gehört nicht zur Web-App. Abgebrochen.')); return }
        location.href = body.redirect_uri
        return
      }
      say(el('p', 'Angemeldet. Du kannst zum Browser auf dem anderen Gerät zurückkehren.', 'ok'))
    } catch (e) {
      say(el('p', `Fehler: ${e instanceof Error ? e.message : String(e)}`))
    }
  }
}

void main()
