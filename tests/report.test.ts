import { it } from 'vitest'
import { measure } from '../src/lab/report-files'
import { reportCandidates } from '../src/candidates/report'

// Misst die Kandidaten und schreibt je Kandidat eine Ergebnisdatei nach results/<id>.json:
//   REPORT=1 pnpm vitest run report                      (alle Kandidaten)
//   REPORT=1 REPORT_ONLY=keyhive,gen2 pnpm vitest run report   (nur diese; die anderen Dateien bleiben)
// Die Matrix und ihre Seite entstehen danach aus den Dateien: pnpm matrix.
// Ein Kandidat wird erst geladen, wenn er ausgewählt ist (src/candidates/report.ts). Kann er hier nicht laden oder
// laufen (kein WASM-Paket, kein lokaler Stack, kein Server-Binary), steht das mit dem Grund in seiner Datei, und der
// Bericht läuft mit dem nächsten weiter. Eine vorhandene Messung ersetzt er dabei nicht: REPORT_OVERWRITE=1 erzwingt es.
it.runIf(process.env.REPORT)('Bericht', async () => {
  const notRun = await measure(reportCandidates, { only: (process.env.REPORT_ONLY ?? '').split(',').filter(Boolean), overwrite: !!process.env.REPORT_OVERWRITE })
  if (notRun.length) process.stdout.write(`\nnicht gelaufen (${notRun.length}):\n  ${notRun.map((x) => `${x.id}: ${x.why}`).join('\n  ')}\n`)
}, 3_600_000)
