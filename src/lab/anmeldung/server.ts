// The example web app as a service (deploy/anmeldung/): plain http behind a TLS-terminating proxy
// (Traefik), the wallet page prebuilt. Bundled with everything it needs by
// scripts/build-anmeldung-server.mjs; the container runs `node server.mjs`.
//
//   PUBLIC_ORIGIN      the address people open, https://… (required)
//   PORT               the port inside the container (default 8080)
//   ANMELDUNG_WALLET   app (default) | demo: where QR code and link send the person; the page lets a
//                      person pick the demo wallet per login
//   WALLET_JS          the prebuilt wallet page (default ./wallet.js next to the server)

import { readFileSync } from 'node:fs'
import { serve } from './http'

export async function main (): Promise<void> {
  const publicOrigin = process.env.PUBLIC_ORIGIN
  if (!publicOrigin || !/^https?:\/\/[^/]+$/.test(publicOrigin)) throw new Error('PUBLIC_ORIGIN must be an origin, e.g. https://anmeldung-demo.example')
  const port = Number(process.env.PORT ?? 8080)
  const wallet = process.env.ANMELDUNG_WALLET === 'demo' ? 'demo' : 'app'
  const script = readFileSync(process.env.WALLET_JS ?? new URL('./wallet.js', import.meta.url), 'utf8')
  await serve({ port, host: '0.0.0.0', publicOrigin, wallet, walletScript: async () => script })
  console.log(`Beispiel-Web-App: ${publicOrigin} (Port ${port}, Wallet: ${wallet})`)
}

void main()
