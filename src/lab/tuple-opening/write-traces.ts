// npx tsx src/lab/tuple-opening/write-traces.ts — writes traces/*.json from the rule.
import { writeFileSync } from 'node:fs'
import { build } from './traces'
for (const t of build()) writeFileSync(new URL(`./traces/${t.name}.json`, import.meta.url), JSON.stringify(t, null, 2) + '\n')
