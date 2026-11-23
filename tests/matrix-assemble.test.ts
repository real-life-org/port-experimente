import { it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { toMarkdown } from '../src/lab/matrix'
import { renderPage, updateFindingsSummary } from '../src/lab/matrix-page'
import { assemble, readRuns } from '../src/lab/report-files'
import { reportCandidates as knownCandidates } from '../src/candidates/report'

// Setzt Matrix und Seite aus den Ergebnisdateien (results/<id>.json) zusammen, ohne einen Kandidaten zu laden:
//   pnpm matrix          (matrix.md, public/matrix.html, Zusammenfassung in public/findings.html)
//   MATRIX=1 MATRIX_OUT=pfad PAGE_OUT=pfad FINDINGS_OUT=pfad pnpm vitest run matrix-assemble
// Läuft vor jedem Build; public/matrix.html und matrix.md liegen nicht im Repo.
it.runIf(process.env.MATRIX)('Matrix aus den Ergebnisdateien', () => {
  const { matrix, page } = assemble(readRuns(knownCandidates))
  const md = toMarkdown(matrix, page.at.slice(0, 10))
  writeFileSync(process.env.MATRIX_OUT ?? 'matrix.md', md)
  writeFileSync(process.env.PAGE_OUT ?? 'public/matrix.html', renderPage(page))
  // Die Zusammenfassung der Befunde-Seite aus denselben Dateien (Zellen mit Münzwurf laufen in jedem Zweig, s. src/lab/zweige.ts).
  const findings = process.env.FINDINGS_OUT ?? 'public/findings.html'
  writeFileSync(findings, updateFindingsSummary(readFileSync(findings, 'utf8'), page))
  process.stdout.write('\n' + md)
})
