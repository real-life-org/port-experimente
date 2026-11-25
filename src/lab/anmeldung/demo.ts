// The demonstration on a real network: the example web app on https on this
// machine's LAN address, with the demo wallet bundled for the phone's browser.
// Run with `pnpm anmeldung:demo` (scripts/anmeldung-demo.mjs).
//
// https is needed because phone browsers give WebCrypto (and so Ed25519) only
// to secure origins. The certificate is self-signed for the LAN address; the
// browsers on laptop and phone show a warning once.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { serve } from './http'

// The address the phone can reach: DEMO_HOST if set, else the first IPv4
// address of an interface that is not a container or bridge interface.
const VIRTUAL = /^(docker|br-|veth|virbr|vboxnet|vmnet|lxc|lxd|cni|flannel|podman|tun|tap|wg|zt)/
function lanAddress (): string {
  if (process.env.DEMO_HOST) return process.env.DEMO_HOST
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL.test(name)) continue
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return '127.0.0.1'
}

function certificate (ip: string): { key: string, cert: string } {
  const dir = join(process.env.PORT_EXPERIMENTE_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'port-experimente'), 'anmeldung')
  mkdirSync(dir, { recursive: true })
  const key = join(dir, `${ip}.key.pem`), cert = join(dir, `${ip}.cert.pem`)
  if (!existsSync(key) || !existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30',
      '-subj', '/CN=anmeldung-demo', '-addext', `subjectAltName=IP:${ip},IP:127.0.0.1,DNS:localhost`, '-keyout', key, '-out', cert], { stdio: 'ignore' })
  }
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
}

async function walletBundle (): Promise<string> {
  const entry = fileURLToPath(new URL('./wallet-page.ts', import.meta.url))
  const out = await build({
    configFile: false, logLevel: 'silent',
    build: { write: false, minify: false, target: 'es2022', lib: { entry, formats: ['es'], fileName: 'wallet' } },
  }) as { output: Array<{ type: string, code?: string }> } | Array<{ output: Array<{ type: string, code?: string }> }>
  const first = Array.isArray(out) ? out[0]! : out
  const chunk = first.output.find((o) => o.type === 'chunk')
  if (!chunk?.code) throw new Error('Wallet-Bündel leer')
  return chunk.code
}

export async function main (port = Number(process.env.PORT ?? 8790)): Promise<void> {
  const ip = lanAddress()
  const origin = `https://${ip}:${port}`
  const script = await walletBundle()
  await serve({ port, host: '0.0.0.0', https: certificate(ip), publicOrigin: origin, walletScript: async () => script })
  console.log(`\nBeispiel-Web-App läuft: ${origin}\n`)
  console.log('Laptop: diese Adresse im Browser öffnen, Warnung zum Zertifikat einmal bestätigen,')
  console.log('        „Mit dem Telefon anmelden“, QR-Code mit der Kamera des Telefons scannen.')
  console.log('Telefon: dieselbe Adresse im Browser öffnen, „Auf diesem Gerät anmelden“.')
  console.log('Beide Geräte im selben Netz. Beenden mit Strg+C.\n')
}
