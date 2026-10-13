import type { Outcome, ScenarioResult } from './types'

// Konformitätsmatrix (Plan: „Träger-Prüfstand und Konformitätsmatrix“, Anton
// 11.10.): je Port eine Tabelle Zusage × Kandidat. Jede Zelle ist kein
// Urteil vom Schreibtisch, sondern die Summe der Szenarien, die die Zusage
// prüfen, wie sie gerade gelaufen sind. Die Zuordnung Szenario → Zusage ist
// die einzige Handarbeit hier; sie sagt, was ein Szenario beweist. Fehlt
// einer Zusage jedes Szenario, steht sie als „nicht geprüft“ in der Tabelle:
// die Lücke ist Teil der Ausgabe.

export type Port = 'autorität' | 'schlüssel' | 'replikation'

export const portTitle: Record<Port, string> = {
  autorität: 'Autoritäts-Port (Access §3, §3.6, §4, §7.3, §9.3)',
  schlüssel: 'Schlüssel-Port (KV1–KV6 aus der Port-Synthese; Geräte aus E7)',
  replikation: 'Replikations-Port (Replication Contract I1–I16, Türen D1–D5; Zustellung DV aus E11)',
}

export interface Promise {
  readonly id: string
  readonly port: Port
  readonly title: string
  /** Stelle in Spec oder Plan, die die Zusage macht. */
  readonly ref: string
  /** Szenarien (S aus scenarios.ts, T aus traeger.ts), die sie prüfen. Leer = nicht geprüft. */
  readonly scenarios: readonly string[]
}

export const promises: Promise[] = [
  // ── Autoritäts-Port ─────────────────────────────────────────────────────
  { id: 'A1', port: 'autorität', title: 'Gründung und Aufnahme: alle sehen dieselbe Mitgliedschaft', ref: 'Access §3', scenarios: ['S1'] },
  { id: 'A2', port: 'autorität', title: 'Entfernung gilt, auch neben einem Schreiben des Entfernten', ref: 'Access §3.6, RLTP-ACC-3400 (Strong Removal)', scenarios: ['S2', 'S4a'] },
  { id: 'A3', port: 'autorität', title: 'Gleichzeitige Entfernungen verschiedener Personen gelten beide', ref: 'Access §3.6 Konfliktmatrix', scenarios: ['S4b'] },
  { id: 'A4', port: 'autorität', title: 'Gegenseitige Entfernung: beide sind draußen, keiner liest Neues', ref: 'Access §3.6; Entscheid 05.10.', scenarios: ['S4c2'] },
  { id: 'A4a', port: 'autorität', title: 'Gegenseitige Entfernung: alle Verbleibenden sind sich einig (kein festes Soll, was ein Kandidat daraus macht)', ref: 'Access §3.6', scenarios: ['S4c'] },
  { id: 'A5', port: 'autorität', title: 'Entfernung neben Rotation eines anderen Mitglieds', ref: 'Access §3.6', scenarios: ['S4d'] },
  { id: 'A6', port: 'autorität', title: 'Zwei gleichzeitige Regeländerungen: Fork, alle einig', ref: 'Access §3.6 Klassenregel 3', scenarios: ['S4e'] },
  { id: 'A7', port: 'autorität', title: 'Regeländerung neben Durchsetzung: Fork, Durchsetzung verfällt, Ende durch Regeländerung auf beide Zweige', ref: 'Access §3.6, 3565–3568', scenarios: ['S4j'] },
  { id: 'A8', port: 'autorität', title: 'Entfernte lädt gleichzeitig ein: die Kette verfällt, niemand aus ihr liest Neues', ref: 'Access RLTP-ACC-3400, 3475', scenarios: ['S4f'] },
  { id: 'A9', port: 'autorität', title: 'Ersteller ohne Sonderrolle: die Gruppe bleibt ohne ihn handlungsfähig', ref: 'Access §3 (RLTP-ACC-3060)', scenarios: ['S8'] },
  { id: 'A10', port: 'autorität', title: 'Offline schreiben, danach konvergieren: gleicher Evidenzbestand, gleicher Zustand', ref: 'Access §3.6; Kandidaten-Invariante I1', scenarios: ['S3'] },
  { id: 'A11', port: 'autorität', title: 'Dienst nach Sichten: Entfernter schreibt gleichzeitig, der Dienst verwirft', ref: 'Access §7.3, §9.3 (P2)', scenarios: ['S10a'] },
  { id: 'A12', port: 'autorität', title: 'Dienst nach Sichten: veraltete Sicht lässt den Entfernten nicht weiterschreiben', ref: 'Access §7.3, §9.3', scenarios: ['S10b'] },
  { id: 'A13', port: 'autorität', title: 'Dienst nach Sichten: gegenseitige Entfernung lässt nur ein Mitglied, Quorum der Sicht', ref: 'Access §7.3 (Quorumregel: Befund 9)', scenarios: ['S10c'] },
  // ── Schlüssel-Port ──────────────────────────────────────────────────────
  { id: 'KV1', port: 'schlüssel', title: 'Frisches Geheimnis je Durchsetzung: der Entfernte (oder das entfernte Gerät) liest Neues nicht', ref: 'Port-Synthese KV1; Access §9', scenarios: ['S2', 'S5b', 'S5c'] },
  { id: 'KV2', port: 'schlüssel', title: 'Genau die Verbleibenden: auch bei gleichzeitigen Durchsetzungen liest niemand Entfernter mit', ref: 'Port-Synthese KV2', scenarios: ['S4b', 'S4c2', 'S4f'] },
  { id: 'KV3', port: 'schlüssel', title: 'Bindung im Log: das Log bindet die Epoche an das Geheimnis (keyOpDigest)', ref: 'Port-Synthese KV3; Access registration/0.27 keyOpDigest', scenarios: [] },
  { id: 'KV4', port: 'schlüssel', title: 'Historie über die Replik: ein Neuling liest Früheres mit dem aktuellen Geheimnis und der Kette', ref: 'Port-Synthese KV4', scenarios: ['S6', 'S6b'] },
  { id: 'KV5', port: 'schlüssel', title: 'Rotation auf Verlangen: nach erbeutetem Zustand liest der Dieb nach der Rotation nicht weiter (PCS)', ref: 'Port-Synthese KV5', scenarios: ['S7', 'S4d'] },
  { id: 'KV6', port: 'schlüssel', title: 'Zusammenführung paralleler Geheimnisse: gleichzeitige Baumänderungen laufen zusammen, ohne dass jemand mitliest', ref: 'Port-Synthese KV6', scenarios: ['S4b', 'S4d', 'S3'] },
  { id: 'K7', port: 'schlüssel', title: 'Geräte je Person: zweites Gerät liest mit, verlorenes Gerät wird allein entfernt, Entfernung einer Person trifft alle ihre Geräte', ref: 'E7 (Blatt je Gerät); Access device.add/revoke', scenarios: ['S5', 'S5b', 'S5c'] },
  // ── Replikations-Port ───────────────────────────────────────────────────
  { id: 'I1', port: 'replikation', title: 'Catch-up: ein spät erscheinendes Gerät konvergiert aus dem Log', ref: 'Replication §5.1', scenarios: ['S6', 'S6b'] },
  { id: 'I2', port: 'replikation', title: 'Kausale Anwendung: der Träger darf umordnen', ref: 'Replication §5.2', scenarios: ['T2'] },
  { id: 'I3', port: 'replikation', title: 'Lauf und Ergebnis gehören zusammen', ref: 'Replication §5.3', scenarios: [] },
  { id: 'I4', port: 'replikation', title: 'Commit vor Weitergabe, Verdrängung der Replik', ref: 'Replication §5.4', scenarios: [] },
  { id: 'I5', port: 'replikation', title: 'Konvergenz gegen ein beglaubigtes Ziel: Zurückhalten wird bemerkt', ref: 'Replication §5.5, Tür D5', scenarios: ['T6', 'T6b'] },
  { id: 'I6', port: 'replikation', title: 'Schlüsselblind: der Träger liest nur Chiffretext mit Umschlag', ref: 'Replication §5.6; Access-Envelope', scenarios: ['T12'] },
  { id: 'I7', port: 'replikation', title: 'Autorisierung nur gegen die vorgelegte Sicht', ref: 'Replication §5.7', scenarios: [] },
  { id: 'I8', port: 'replikation', title: 'Zustand, nicht Kante: Duplikate und alte Rahmen ändern nichts', ref: 'Replication §5.8; Delivery 6.3', scenarios: ['T3', 'T4'] },
  { id: 'I9', port: 'replikation', title: 'Dauerhaftigkeit je Transaktion', ref: 'Replication §5.9', scenarios: [] },
  { id: 'I10', port: 'replikation', title: 'Lokale Wahrheit repliziert nie', ref: 'Replication §5.10', scenarios: [] },
  { id: 'I11', port: 'replikation', title: 'Wiederholungsautorität liegt im dauerhaften Log', ref: 'Replication §5.11', scenarios: [] },
  { id: 'I12', port: 'replikation', title: 'Lückenreparatur, adressiert und endend', ref: 'Replication §5.12; Delivery DV2', scenarios: ['T1'] },
  { id: 'I13', port: 'replikation', title: 'Kostenobergrenze je Seite', ref: 'Replication §5.13', scenarios: [] },
  { id: 'I14', port: 'replikation', title: 'Aufnahme an jedem Eingang', ref: 'Replication §5.14', scenarios: [] },
  { id: 'I15', port: 'replikation', title: 'Neubindung nach Verlust: Trägerwechsel mitten im Leben', ref: 'Replication §5.15', scenarios: ['T8'] },
  { id: 'I16', port: 'replikation', title: 'Nebenläufige Durchsetzung forkt, sonst nichts', ref: 'Replication §5.16', scenarios: [] },
  { id: 'D1', port: 'replikation', title: 'Signierter DAG, Form vor Inhalt: der Träger kann nur zerstören, nie umdeuten', ref: 'Replication Tür D1', scenarios: ['T5'] },
  { id: 'R1', port: 'replikation', title: 'Dienstklassen: blind bedient den Entfernten weiter (er öffnet nichts), Sicht/Log verweigern', ref: 'Access §9.3', scenarios: ['T7'] },
  { id: 'DV4', port: 'replikation', title: 'Pseudonym je Gruppe: der Träger verbindet Gruppen nicht über Identitäten', ref: 'Delivery-Hypothesen DV4/DV6', scenarios: ['T11'] },
  { id: 'DV2', port: 'replikation', title: 'Zustellung: Quittungsverlust und unerreichbarer Träger enden nie still', ref: 'Delivery 6.1, 6.3 (E11: T9, T10)', scenarios: [] },
]

/** `teilweise`: ein Teil der zugeordneten Szenarien besteht, der Rest ist nicht abbildbar oder nicht gelaufen; die Zusage gilt damit nicht. */
export type CellStatus = Outcome | 'teilweise' | 'nicht geprüft'

export interface Cell {
  readonly status: CellStatus
  /** Jedes zugeordnete Szenario mit seinem Ergebnis; `nicht gelaufen`, wenn der Lauf es nicht enthielt. */
  readonly evidence: ReadonlyArray<{ scenario: string; outcome: Outcome | 'nicht gelaufen' }>
}

export interface CandidateRun {
  readonly id: string
  readonly scenarios: readonly ScenarioResult[]
  readonly carrier: readonly ScenarioResult[]
}

export interface Row {
  readonly promise: Promise
  readonly cells: Record<string, Cell>
}

export interface Matrix {
  readonly candidates: readonly string[]
  readonly ports: ReadonlyArray<{ port: Port; title: string; rows: Row[] }>
}

/**
 * Eine Zelle aus den Ergebnissen. Eine Zusage gilt nur, wenn jedes zugeordnete
 * Szenario besteht (Review zu #35: ein bestandener Teil machte eine
 * zusammengesetzte Zusage grün). Scheitert eines: nicht bestanden. Besteht
 * ein Teil, der Rest ist nicht abbildbar oder nicht gelaufen: teilweise.
 * Alles nicht abbildbar: nicht abbildbar. Ohne Szenario: nicht geprüft.
 */
export function cell(p: Promise, results: ReadonlyMap<string, Outcome>): Cell {
  const evidence = [...p.scenarios].sort().map((s) => ({ scenario: s, outcome: results.get(s) ?? ('nicht gelaufen' as const) }))
  const outcomes = evidence.map((e) => e.outcome)
  let status: CellStatus
  if (!p.scenarios.length) status = 'nicht geprüft'
  else if (outcomes.includes('nicht bestanden')) status = 'nicht bestanden'
  else if (outcomes.every((o) => o === 'bestanden')) status = 'bestanden'
  else if (outcomes.includes('bestanden')) status = 'teilweise'
  else if (outcomes.every((o) => o === 'nicht abbildbar')) status = 'nicht abbildbar'
  else status = 'nicht geprüft'
  return { status, evidence }
}

export function buildMatrix(runs: readonly CandidateRun[]): Matrix {
  const byCandidate = new Map(runs.map((r) => [r.id, new Map([...r.scenarios, ...r.carrier].map((x) => [x.scenario, x.outcome] as const))] as const))
  const ports = (['autorität', 'schlüssel', 'replikation'] as Port[]).map((port) => ({
    port,
    title: portTitle[port],
    rows: promises
      .filter((p) => p.port === port)
      .map((promise) => ({ promise, cells: Object.fromEntries(runs.map((r) => [r.id, cell(promise, byCandidate.get(r.id)!)])) })),
  }))
  return { candidates: runs.map((r) => r.id), ports }
}

const mark: Record<Outcome | 'nicht gelaufen', string> = { bestanden: '✓', 'nicht bestanden': '✗', 'nicht abbildbar': '–', 'nicht gelaufen': '?' }

export function cellText(c: Cell): string {
  if (c.status === 'nicht geprüft') return 'nicht geprüft'
  const marks = c.evidence.map((e) => `${mark[e.outcome]} ${e.scenario}`).join(' ')
  return c.status === 'teilweise' ? `teilweise: ${marks}` : marks
}

/** Markdown: eine Tabelle je Port, Kandidaten als Spalten. */
export function toMarkdown(m: Matrix, at = new Date().toISOString().slice(0, 10)): string {
  const lines: string[] = ['# Konformitätsmatrix', '', `Stand ${at}. Eine Zusage gilt nur, wenn jedes zugeordnete Szenario besteht: ✓ bestanden, ✗ nicht bestanden, – nicht abbildbar, ? nicht gelaufen. „teilweise“ heißt: ein Teil besteht, der Rest ist nicht abbildbar oder nicht gelaufen. „nicht geprüft“ heißt: es gibt noch kein Szenario dafür.`, '']
  for (const p of m.ports) {
    lines.push(`## ${p.title}`, '', `| Zusage | ${m.candidates.join(' | ')} |`, `|---|${m.candidates.map(() => '---').join('|')}|`)
    for (const row of p.rows) lines.push(`| ${row.promise.id} ${row.promise.title} (${row.promise.ref}) | ${m.candidates.map((c) => cellText(row.cells[c]!)).join(' | ')} |`)
    lines.push('')
  }
  return lines.join('\n')
}
