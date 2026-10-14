import { candidates, transportLabel } from './candidates'
import { runAll } from './lab/scenarios'
import { runCarrier } from './lab/traeger'
import { runContentLoad, runLoadMedian, type LoadResult } from './lab/load'
import { buildMatrix, cellText, type CandidateRun, type Matrix } from './lab/matrix'
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

const cls = (o: ScenarioResult['outcome'] | 'teilweise' | 'nicht geprüft') => (o === 'bestanden' ? 'ok' : o === 'nicht bestanden' ? 'no' : o === 'teilweise' ? 'part' : 'na')

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

/** Konformitätsmatrix: je Port Zusage × Kandidat, jede Zelle aus den gelaufenen Szenarien. */
function renderMatrix(m: Matrix) {
  const sec = el('section')
  sec.append(el('h2', 'Konformitätsmatrix'))
  sec.append(el('div', 'Eine Zusage gilt nur, wenn jedes zugeordnete Szenario besteht: ✓ bestanden, ✗ nicht bestanden, – nicht abbildbar, ? nicht gelaufen. „teilweise“: ein Teil besteht, der Rest nicht abbildbar oder nicht gelaufen. „nicht geprüft“: noch kein Szenario; „nicht gelaufen“: Szenario vorhanden, im Lauf nicht enthalten. Kandidaten nur für Node fehlen hier.', 'load'))
  for (const p of m.ports) {
    sec.append(el('h3', p.title))
    const wrap = el('div', undefined, 'scroll')
    const t = el('table')
    const head = el('tr')
    for (const h of ['Zusage', ...m.candidates]) head.append(el('th', h))
    t.append(head)
    for (const row of p.rows) {
      const tr = el('tr')
      const z = el('td')
      z.append(el('span', row.promise.id + ' ', 'mono'), el('span', row.promise.title), el('div', row.promise.ref + (row.promise.gap ? ` · Lücke: ${row.promise.gap}` : ''), 'env'))
      tr.append(z)
      for (const c of m.candidates) {
        const cellEl = el('td')
        const cell = row.cells[c]!
        cellEl.append(el('span', cellText(cell), `o ${cls(cell.status)}`))
        tr.append(cellEl)
      }
      t.append(tr)
    }
    wrap.append(t)
    sec.append(wrap)
  }
  out.append(sec)
}

function render(title: string, transport: string, results: ScenarioResult[], carrier: ScenarioResult[], load: LoadResult, content: LoadResult) {
  const sec = el('section')
  sec.append(el('h2', title))
  sec.append(el('div', `Transport: ${transport}. Laufzeiten nur innerhalb derselben Transportklasse vergleichbar.`, 'load'))
  const l = el('div', loadLine('S9 Autorität', load), 'load')
  sec.append(l)
  sec.append(el('div', loadLine('S9b Inhalte', content), 'load'))
  const wrap = el('div', undefined, 'scroll')
  const t = el('table')
  const head = el('tr')
  for (const h of ['', 'Szenario', 'Ergebnis', 'Autorität', 'Schlüssel', 'ms']) head.append(el('th', h))
  t.append(head)
  for (const r of [...results, ...carrier]) {
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
  const report: Array<{ candidate: string; transport: string; results: ScenarioResult[]; carrier: ScenarioResult[]; load: LoadResult; content: LoadResult }> = []
  const runs: CandidateRun[] = []
  for (const c of candidates) {
    if (c.nodeOnly || !c.make) {
      const sec = el('section')
      sec.append(el('h2', c.title), el('div', `Transport: ${transportLabel[c.transport]}.`, 'load'), el('p', `Im Browser nicht ausführbar: ${c.nodeOnly ?? 'nur in Node'}.`))
      out.append(sec)
      continue
    }
    state.textContent = `läuft: ${c.id} …`
    await new Promise((r) => setTimeout(r, 0))
    const results = await runAll(c.make)
    const carrier = await runCarrier(c.make)
    const load = await runLoadMedian(c.make, c.loadRuns, c.loadSize?.members, c.loadSize?.operations)
    const content = await runContentLoad(c.make)
    report.push({ candidate: c.id, transport: c.transport, results, carrier, load, content })
    runs.push({ id: c.id, scenarios: results, carrier })
    render(c.title, transportLabel[c.transport], results, carrier, load, content)
  }
  const matrix = buildMatrix(runs)
  renderMatrix(matrix)
  state.textContent = 'fertig'
  json.value = JSON.stringify({ at: new Date().toISOString(), device: deviceInput.value.trim() || null, env, report, matrix }, null, 1)
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
