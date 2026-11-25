// Starts the login demonstration (src/lab/anmeldung/demo.ts). Vite loads the
// TypeScript module directly, the same way the bench does.
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' })
const demo = await vite.ssrLoadModule('/src/lab/anmeldung/demo.ts')
await demo.main()
