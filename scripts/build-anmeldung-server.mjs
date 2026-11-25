// Builds the example web app of the login prototype as a service (deploy/anmeldung/): one bundled
// server file and the wallet page, both into dist-anmeldung/. Everything the server imports (the
// library, qrcode) is bundled, so the image needs Node and these two files only.
import { build } from 'vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = fileURLToPath(new URL('../dist-anmeldung/', import.meta.url))

await build({
  root, configFile: false, logLevel: 'warn', publicDir: false,
  build: { outDir, emptyOutDir: true, minify: false, target: 'es2022', lib: { entry: 'src/lab/anmeldung/wallet-page.ts', formats: ['es'], fileName: () => 'wallet.js' } },
})
await build({
  root, configFile: false, logLevel: 'warn', publicDir: false,
  ssr: { noExternal: true, target: 'node' },
  build: { outDir, emptyOutDir: false, minify: false, target: 'node22', ssr: 'src/lab/anmeldung/server.ts', rollupOptions: { output: { entryFileNames: 'server.mjs', format: 'es' } } },
})
console.log('dist-anmeldung/: server.mjs, wallet.js')
