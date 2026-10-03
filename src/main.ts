import { candidates } from './candidates'
import { runAll } from './lab/scenarios'
import { runContentLoad, runLoadMedian, type LoadResult } from './lab/load'
import type { ScenarioResult } from './lab/types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const runBtn = $<HTMLButtonElement>('run')
const copyBtn = $<HTMLButtonElement>('copy')
const out = $('out')
const state = $('state')
const json = $<HTMLTextAreaElement>('json')
const deviceInput = $<HTMLInputElement>('device')
try { deviceInput.value = localStorage.getItem('port-experimente:geraet') ?? '' } catch {}
deviceInput.addEventListener('change', () => {
  try { localStorage.setItem('port-experimente:geraet', deviceInput.value) } catch {}
})

const env = {
  userAgent: navigator.userAgent,
  cores: navigator.hardwareConcurrency,
  wasm: typeof WebAssembly === 'object',
  build: import.meta.env.VITE_BUILD ?? 'lokal',
}
$('env').textContent = `${env.userAgent} · ${env.cores} Kerne · WebAssembly ${env.wasm ? 'ja' : 'nein'} · Build ${env.build}`

const cls = (o: ScenarioResult['outcome']) => (o === 'bestanden' ? 'ok' : o === 'nicht bestanden' ? 'no' : 'na')

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const e = document.createElement(tag)
  if (text !== undefined) e.textContent = text
  if (className) e.className = className
  return e
}

function loadLine(name: string, load: LoadResult) {
  return load.error
    ? `${name}: Fehler ${load.error}`
    : `${name}${load.runs ? ` (Median aus ${load.runs} Läufen)` : ''}: ${load.members} Mitglieder, ${load.operations} Operationen in ${load.ms.toFixed(0)} ms (${load.msPerOp.toFixed(3)} ms je Operation)${load.idleMs === undefined ? '' : `, davon ${load.idleMs.toFixed(0)} ms Warten auf Ruhe`}${load.msPerDelivery === undefined ? '' : `; je Gerät und Nachricht ${load.msPerDelivery.toFixed(2)} ms`}`
}

function render(title: string, results: ScenarioResult[], load: LoadResult, content: LoadResult) {
  const sec = el('section')
  sec.append(el('h2', title))
  const l = el('div', loadLine('S9 Autorität', load), 'load')
  sec.append(l)
  sec.append(el('div', loadLine('S9b Inhalte', content), 'load'))
  const wrap = el('div', undefined, 'scroll')
  const t = el('table')
  const head = el('tr')
  for (const h of ['', 'Szenario', 'Ergebnis', 'Autorität', 'Schlüssel', 'ms']) head.append(el('th', h))
  t.append(head)
  for (const r of results) {
    const tr = el('tr')
    tr.append(el('td', r.scenario, 'mono'), el('td', r.title))
    const td = el('td'); td.append(el('span', r.outcome, `o ${cls(r.outcome)}`)); tr.append(td)
    tr.append(el('td', r.authority), el('td', r.keys), el('td', r.ms.toFixed(1), 'mono'))
    t.append(tr)
  }
  wrap.append(t)
  sec.append(wrap)
  out.append(sec)
}

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true
  copyBtn.disabled = true
  out.replaceChildren()
  const report: Array<{ candidate: string; results: ScenarioResult[]; load: LoadResult; content: LoadResult }> = []
  for (const c of candidates) {
    state.textContent = `läuft: ${c.id} …`
    await new Promise((r) => setTimeout(r, 0))
    const results = await runAll(c.make)
    const load = await runLoadMedian(c.make, c.loadRuns)
    const content = await runContentLoad(c.make)
    report.push({ candidate: c.id, results, load, content })
    render(c.title, results, load, content)
  }
  state.textContent = 'fertig'
  json.value = JSON.stringify({ at: new Date().toISOString(), device: deviceInput.value.trim() || null, env, report }, null, 1)
  runBtn.disabled = false
  copyBtn.disabled = false
})

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(json.value)
    state.textContent = 'kopiert'
  } catch {
    json.hidden = false
    json.select()
    state.textContent = 'Kopieren nicht erlaubt: Text ist markiert'
  }
})
