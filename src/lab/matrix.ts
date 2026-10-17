import type { Outcome, ScenarioResult } from './types'

// Konformitätsmatrix (Plan: „Träger-Prüfstand und Konformitätsmatrix“, Anton
// 11.10.): je Port eine Tabelle Zusage × Kandidat. Jede Zelle ist kein
// Urteil vom Schreibtisch, sondern die Summe der Szenarien, die die Zusage
// prüfen, wie sie gerade gelaufen sind. Die Zuordnung Szenario → Zusage ist
// die einzige Handarbeit hier; sie sagt, was ein Szenario beweist. Fehlt
// einer Zusage jedes Szenario, steht sie als „nicht geprüft“ in der Tabelle:
// die Lücke ist Teil der Ausgabe.

export type Port = 'autorität' | 'schlüssel' | 'replikation' | 'mehrgerät'

export const portTitle: Record<Port, string> = {
  autorität: 'Autoritäts-Port (Access §3, §3.6, §4, §7.3, §9.3)',
  schlüssel: 'Schlüssel-Port (KV1–KV6 aus der Port-Synthese; Geräte aus E7)',
  replikation: 'Replikations-Port (Replication Contract I1–I16, Türen D1–D5; Zustellung DV aus E11)',
  mehrgerät: 'Mehrgeräte-Port (E15: Holder-Zustand über mehrere Geräte einer Person; Trust 0.32 §8/§6a, HSC)',
}

export interface Promise {
  readonly id: string
  readonly port: Port
  readonly title: string
  /** Stelle in Spec oder Plan, die die Zusage macht. */
  readonly ref: string
  /** Szenarien (S aus scenarios.ts, T aus traeger.ts), die sie prüfen. Leer = nicht geprüft. */
  readonly scenarios: readonly string[]
  /** Bei leeren Szenarien: warum es noch keines gibt (Harness-Grenze, offene Spec-Frage, noch nicht gebaut). */
  readonly gap?: string
}

export const promises: Promise[] = [
  // ── Autoritäts-Port ─────────────────────────────────────────────────────
  { id: 'A1', port: 'autorität', title: 'Gründung und Aufnahme: alle sehen dieselbe Mitgliedschaft', ref: 'Access §3', scenarios: ['S1'] },
  { id: 'A2', port: 'autorität', title: 'Entfernung gilt, auch neben einem Schreiben des Entfernten', ref: 'Access §3.6, RLTP-ACC-3400 (Strong Removal)', scenarios: ['S2', 'S4a'] },
  { id: 'A3', port: 'autorität', title: 'Gleichzeitige Entfernungen verschiedener Personen gelten beide', ref: 'Access §3.6 Konfliktmatrix', scenarios: ['S4b'] },
  { id: 'A4', port: 'autorität', title: 'Gegenseitige Entfernung: beide sind draußen, keiner liest Neues', ref: 'Access §3.6; Entscheid 05.10.', scenarios: ['S4c2'] },
  { id: 'A4a', port: 'autorität', title: 'Gegenseitige Entfernung: alle Verbleibenden sind sich einig (kein festes Soll, was ein Kandidat daraus macht)', ref: 'Access §3.6', scenarios: ['S4c'] },
  { id: 'A5', port: 'autorität', title: 'Entfernung neben Rotation eines anderen Mitglieds', ref: 'Access §3.6', scenarios: ['S4d'] },
  { id: 'A6', port: 'autorität', title: 'Zwei gleichzeitige Regeländerungen: alle Repliken einig über Zustand und Mitgliedschaft (ob ein Fork entsteht, prüft erst S4j über A7)', ref: 'Access §3.6 Klassenregel 3', scenarios: ['S4e'] },
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
  { id: 'KV3', port: 'schlüssel', title: 'Bindung im Log: eine Baumänderung, die kein Logeintrag deckt, eröffnet keinen Zugang', ref: 'Port-Synthese KV3; Access registration/0.27 keyOpDigest', scenarios: ['S11'] },
  { id: 'KV4', port: 'schlüssel', title: 'Historie über die Replik: ein Neuling liest Früheres mit dem aktuellen Geheimnis und der Kette', ref: 'Port-Synthese KV4', scenarios: ['S6', 'S6b'] },
  { id: 'KV5', port: 'schlüssel', title: 'Rotation auf Verlangen: nach erbeutetem Zustand liest der Dieb nach der Rotation nicht weiter (PCS)', ref: 'Port-Synthese KV5', scenarios: ['S7', 'S4d'] },
  { id: 'KV6', port: 'schlüssel', title: 'Zusammenführung paralleler Geheimnisse: gleichzeitige Baumänderungen laufen zusammen, ohne dass jemand mitliest', ref: 'Port-Synthese KV6', scenarios: ['S4b', 'S4d', 'S3'] },
  { id: 'K7', port: 'schlüssel', title: 'Geräte je Person: zweites Gerät liest mit, verlorenes Gerät wird allein entfernt, Entfernung einer Person trifft alle ihre Geräte', ref: 'E7 (Blatt je Gerät); Access device.add/revoke', scenarios: ['S5', 'S5b', 'S5c'] },
  // ── Replikations-Port ───────────────────────────────────────────────────
  { id: 'I1', port: 'replikation', title: 'Catch-up: ein spät erscheinendes Gerät konvergiert aus dem Log', ref: 'Replication §5.1', scenarios: ['S6', 'S6b'] },
  { id: 'I2', port: 'replikation', title: 'Kausale Anwendung: der Träger darf umordnen', ref: 'Replication §5.2', scenarios: ['T2'] },
  { id: 'I3', port: 'replikation', title: 'Lauf und Ergebnis gehören zusammen', ref: 'Replication §5.3', scenarios: [], gap: 'noch kein Szenario, das Läufe zählt und jedem genau ein Ergebnis zuordnet; T1 zeigt nur den Endzustand' },
  { id: 'I4', port: 'replikation', title: 'Commit vor Weitergabe, Verdrängung der Replik', ref: 'Replication §5.4', scenarios: [], gap: 'der Prüfstand hat keinen dauerhaften Speicher, Commit ist nicht beobachtbar' },
  { id: 'I5', port: 'replikation', title: 'Konvergenz gegen ein beglaubigtes Ziel: Zurückhalten wird bemerkt', ref: 'Replication §5.5, Tür D5', scenarios: ['T6', 'T6b'] },
  { id: 'I6', port: 'replikation', title: 'Schlüsselblind: der Träger liest nur Chiffretext mit Umschlag', ref: 'Replication §5.6; Access-Envelope', scenarios: ['T12'] },
  { id: 'I7', port: 'replikation', title: 'Autorisierung nur gegen die vorgelegte Sicht', ref: 'Replication §5.7', scenarios: [], gap: 'T7 prüft nur, dass der Entfernte nichts liest; ein Szenario müsste die Sicht wechseln und das Urteil des Dienstes dagegen prüfen' },
  { id: 'I8', port: 'replikation', title: 'Zustand, nicht Kante: Duplikate und alte Rahmen ändern nichts', ref: 'Replication §5.8; Delivery 6.3', scenarios: ['T3', 'T4'] },
  { id: 'I9', port: 'replikation', title: 'Dauerhaftigkeit je Transaktion', ref: 'Replication §5.9', scenarios: [], gap: 'kein dauerhafter Speicher im Prüfstand (Harness-Grenze)' },
  { id: 'I10', port: 'replikation', title: 'Lokale Wahrheit repliziert nie', ref: 'Replication §5.10', scenarios: [], gap: 'noch kein Szenario, das die getragenen Rahmen auf lokale Urteile (Notizen, Verdikte) prüft; T12 prüft nur Namen und Inhalt' },
  { id: 'I11', port: 'replikation', title: 'Wiederholungsautorität liegt im dauerhaften Log', ref: 'Replication §5.11', scenarios: [], gap: 'kein dauerhafter Speicher im Prüfstand; der Ausgang (PWS: awaiting-transport) ist nur ein Hinweis' },
  { id: 'I12', port: 'replikation', title: 'Lückenreparatur, adressiert und endend', ref: 'Replication §5.12; Delivery DV2', scenarios: ['T1'] },
  { id: 'I13', port: 'replikation', title: 'Kostenobergrenze je Seite', ref: 'Replication §5.13', scenarios: [], gap: 'S9/S9b messen Zeit je Operation, nicht Transaktionen und Rundreisen je Seite' },
  { id: 'I14', port: 'replikation', title: 'Aufnahme an jedem Eingang', ref: 'Replication §5.14', scenarios: [], gap: 'der Prüfstand hat einen Eingang je Gerät (receive); mehrere Eingänge sind nicht modelliert' },
  { id: 'I15', port: 'replikation', title: 'Neubindung nach Verlust: Trägerwechsel mitten im Leben', ref: 'Replication §5.15', scenarios: ['T8'] },
  { id: 'I16', port: 'replikation', title: 'Nebenläufige Durchsetzung forkt, sonst nichts', ref: 'Replication §5.16', scenarios: [], gap: 'I16 ist auf Access 0.53 gepinnt und widerspricht der Konfliktmatrix 0.56 (Durchsetzung ∥ Durchsetzung forkt nicht, S4b/S4c); erst der Abgleich, dann ein Szenario' },
  { id: 'D1', port: 'replikation', title: 'Signierter DAG, Form vor Inhalt: der Träger kann nur zerstören, nie umdeuten', ref: 'Replication Tür D1', scenarios: ['T5'] },
  { id: 'R1', port: 'replikation', title: 'Dienstklassen: blind bedient den Entfernten weiter (er öffnet nichts), Sicht/Log verweigern', ref: 'Access §9.3', scenarios: ['T7'] },
  { id: 'DV4', port: 'replikation', title: 'Pseudonym je Gruppe: der Träger verbindet Gruppen nicht über Identitäten', ref: 'Delivery-Hypothesen DV4/DV6', scenarios: ['T11'] },
  { id: 'DV2', port: 'replikation', title: 'Zustellung: Quittungsverlust und unerreichbarer Träger enden nie still', ref: 'Delivery 6.1, 6.3 (E11: T9, T10)', scenarios: [], gap: 'braucht einen Zustellungs-Adapter (E11, nach IIW)' },
  // ── Mehrgeräte-Port (E15; Szenarien X in src/lab/mehrgeraet/scenarios.ts) ──
  { id: 'MG1', port: 'mehrgerät', title: 'Mediatorgeräte: ein Vorrats-Schlüssel wird in höchstens einem Akt benannt, und zwei getrennte Mediatorgeräte überschreiten das gemeinsame Annahmebudget der Seite nicht', ref: 'Trust 0.32 §8 8570.1, 8510 (E15 X1, X13)', scenarios: ['X1', 'X13'] },
  { id: 'MG2', port: 'mehrgerät', title: 'Harte Annahmegrenze: zehn Annahmen je Mediatorbeziehung über alle Geräte der Person', ref: '§8 8510, 8640.10 (X2)', scenarios: ['X2'] },
  { id: 'MG3', port: 'mehrgerät', title: 'Ein Zustand je Person: Consent und Ablehnung sind terminal, die Gegenseite sieht nichts, was die Person als Ganzes nicht trägt', ref: '§8 8325.A3/A4, 8765 (X3, später X18)', scenarios: ['X3'] },
  { id: 'MG4', port: 'mehrgerät', title: 'Klassenwiderruf neben Versand und altem Vorrat: der laufende Akt läuft weiter, Ms Sicht wird leer, keine Equivokation, kein Ticket auf einen zurückgezogenen Schlüssel wird angenommen', ref: '§8 8232.2, 8535, 8475.S6, 6270 (X4, X16)', scenarios: ['X4', 'X16'] },
  { id: 'MG5', port: 'mehrgerät', title: 'Abgang beendet Pflichten; ein Replay von einem anderen Gerät belebt nichts', ref: '§6a 6845.7, 6845.10 (X5)', scenarios: ['X5'] },
  { id: 'MG6', port: 'mehrgerät', title: 'Wiederherstellung aus Backup: keine Nummernwiederverwendung, kein veralteter Vorrat, keine verlorenen Akte', ref: '§8 8500, 8315–8318 (X6, später X19)', scenarios: ['X6'] },
  { id: 'MG7', port: 'mehrgerät', title: 'Kontinuität über Geräte: zwei Begegnungen derselben Personen auf verschiedenen Geräten werden eine Beziehung, keine Doppel', ref: '§6a 2300, 6975, 6987; I-6 (X7, X14, X15)', scenarios: ['X7', 'X14', 'X15'] },
  { id: 'MG8', port: 'mehrgerät', title: 'Enrollment: ein neues Gerät sieht alles und handelt sofort', ref: 'HSC-020 Ersatz, Identity Enrollment (X8)', scenarios: ['X8'] },
  { id: 'MG9', port: 'mehrgerät', title: 'Gerätewiderruf: ein widerrufenes Gerät liest nichts Neues, auch nicht mit dem alten Zustand', ref: 'Identity Widerruf; K7 (X9, später X20)', scenarios: ['X9'] },
  { id: 'MG10', port: 'mehrgerät', title: 'Rechte je Gerät oder App: eine eingeschränkte App kann nur, was ihr Recht erlaubt', ref: 'Delegationsprofil K2 (X10, später X22)', scenarios: ['X10'] },
  { id: 'MG11', port: 'mehrgerät', title: 'Konvergenz nach langer Trennung und Journalreparatur: gleiche fachliche Projektion aller Geräte, kein fehlender Batch, die Reparatur endet', ref: 'HSC-440; Plan E15 Abschnitt 5 (X11, X21)', scenarios: ['X11', 'X21'] },
  { id: 'MG12', port: 'mehrgerät', title: 'Zustellung bei Mehrgerät: Quittungsverlust und unerreichbarer Träger je Gerät enden nie still, Wirkung einmal', ref: 'Delivery 6.1, 6.3 (X12)', scenarios: ['X12'] },
]

/** `teilweise`: ein Teil der zugeordneten Szenarien besteht, der Rest ist nicht abbildbar oder nicht gelaufen; die Zusage gilt damit nicht. */
export type CellStatus = Outcome | 'teilweise' | 'nicht geprüft'

export interface Cell {
  readonly status: CellStatus
  /** Jedes zugeordnete Szenario mit seinem Ergebnis; `nicht gelaufen`, wenn der Lauf es nicht enthielt; Marken für Absturz und geänderte Zusage bleiben erhalten (S2). */
  readonly evidence: ReadonlyArray<{ scenario: string; outcome: Outcome | 'nicht gelaufen'; crashed?: boolean; promiseChanged?: boolean }>
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
  /** Je Port die Kandidaten seiner Familie: Gruppen-Kandidaten (S/T) in den drei Gruppen-Ports, Mehrgeräte-Kandidaten (X) im Mehrgeräte-Port. */
  readonly ports: ReadonlyArray<{ port: Port; title: string; candidates: readonly string[]; rows: Row[] }>
}

/**
 * Eine Zelle aus den Ergebnissen. Eine Zusage gilt nur, wenn jedes zugeordnete
 * Szenario besteht (Review zu #35: ein bestandener Teil machte eine
 * zusammengesetzte Zusage grün). Scheitert eines: nicht bestanden. Besteht
 * ein Teil, der Rest ist nicht abbildbar oder nicht gelaufen: teilweise.
 * Alles nicht abbildbar: nicht abbildbar. Ohne Szenario: nicht geprüft.
 */
export type CellResult = { outcome: Outcome; crashed?: boolean; promiseChanged?: boolean }

export function cell(p: Promise, results: ReadonlyMap<string, CellResult>): Cell {
  const evidence = [...p.scenarios].sort().map((s) => {
    const r = results.get(s)
    return r ? { scenario: s, outcome: r.outcome, crashed: r.crashed, promiseChanged: r.promiseChanged } : { scenario: s, outcome: 'nicht gelaufen' as const }
  })
  // Ein abgebrochener Lauf ist kein gemessener Verstoß (Issue #60): für den Status zählt er wie „nicht gelaufen“, die Marke bleibt im Beleg.
  const outcomes = evidence.map((e) => (e.crashed ? ('nicht gelaufen' as const) : e.outcome))
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
  const byCandidate = new Map(runs.map((r) => [r.id, new Map([...r.scenarios, ...r.carrier].map((x) => [x.scenario, { outcome: x.outcome, crashed: x.crashed, promiseChanged: x.promiseChanged }] as const))] as const))
  // Zwei Familien: Gruppen-Kandidaten (S/T/Z-Szenarien) stehen in den drei Gruppen-Ports, Mehrgeräte-Kandidaten (X) im Mehrgeräte-Port.
  const family = (r: CandidateRun) => ([...r.scenarios, ...r.carrier].some((x) => x.scenario.startsWith('X')) ? 'X' : 'ST')
  const ports = (['autorität', 'schlüssel', 'replikation', 'mehrgerät'] as Port[]).map((port) => {
    const ofPort = promises.filter((p) => p.port === port)
    const cands = runs.filter((r) => family(r) === (port === 'mehrgerät' ? 'X' : 'ST')).map((r) => r.id)
    return {
      port,
      title: portTitle[port],
      candidates: cands,
      rows: ofPort.map((promise) => ({ promise, cells: Object.fromEntries(cands.map((c) => [c, cell(promise, byCandidate.get(c)!)])) })),
    }
  })
  return { candidates: runs.map((r) => r.id), ports }
}

const mark: Record<Outcome | 'nicht gelaufen', string> = { bestanden: '✓', 'nicht bestanden': '✗', 'nicht abbildbar': '–', 'nicht gelaufen': '?' }

export function cellText(c: Cell): string {
  if (!c.evidence.length) return 'nicht geprüft'
  const marks = c.evidence.map((e) => `${e.crashed ? '⚠' : e.promiseChanged ? '≈' : mark[e.outcome]} ${e.scenario}`).join(' ')
  return c.status === 'teilweise' ? `teilweise: ${marks}` : c.status === 'nicht geprüft' ? `nicht gelaufen: ${marks}` : marks
}

/** Markdown: eine Tabelle je Port, Kandidaten als Spalten. */
export function toMarkdown(m: Matrix, at = new Date().toISOString().slice(0, 10)): string {
  const lines: string[] = ['# Konformitätsmatrix', '', `Stand ${at}. Eine Zusage gilt nur, wenn jedes zugeordnete Szenario besteht: ✓ bestanden, ✗ nicht bestanden, – nicht abbildbar, ? nicht gelaufen, ⚠ Lauf abgebrochen (kein gemessener Verstoß), ≈ Zusage geändert (ein ✓ unter einer Ersatzregel, nie Erfüllung der alten). „teilweise“ heißt: ein Teil besteht, der Rest ist nicht abbildbar oder nicht gelaufen. „nicht geprüft“ heißt: es gibt noch kein Szenario dafür; „nicht gelaufen“: es gibt eines, der Lauf enthielt es nicht.`, '']
  for (const p of m.ports) {
    if (!p.candidates.length) continue
    lines.push(`## ${p.title}`, '', `| Zusage | ${p.candidates.join(' | ')} |`, `|---|${p.candidates.map(() => '---').join('|')}|`)
    for (const row of p.rows) lines.push(`| ${row.promise.id} ${row.promise.title} (${row.promise.ref})${row.promise.gap ? ` — Lücke: ${row.promise.gap}` : ''} | ${p.candidates.map((c) => cellText(row.cells[c]!)).join(' | ')} |`)
    lines.push('')
  }
  return lines.join('\n')
}
