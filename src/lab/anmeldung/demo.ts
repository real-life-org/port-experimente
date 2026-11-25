// The demonstration on a real network: the example web app on https on this
// machine's LAN address, with the demo wallet bundled for the phone's browser.
// Run with `pnpm anmeldung:demo` (scripts/anmeldung-demo.mjs).
//
// https is needed because phone browsers give WebCrypto (and so Ed25519) only
// to secure origins. The certificate is self-signed for the LAN address; the
// browsers on laptop and phone show a warning once.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
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

/** the certificate's name for the host: an IP address or a DNS name (DEMO_HOST may be either) */
export const sanOf = (host: string): string => (isIP(host) ? `IP:${host}` : `DNS:${host}`)

function certificate (ip: string): { key: string, cert: string } {
  const dir = join(process.env.PORT_EXPERIMENTE_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'port-experimente'), 'anmeldung')
  mkdirSync(dir, { recursive: true })
  const key = join(dir, `${ip}.key.pem`), cert = join(dir, `${ip}.cert.pem`)
  if (!existsSync(key) || !existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30',
      '-subj', '/CN=anmeldung-demo', '-addext', `subjectAltName=${sanOf(ip)},IP:127.0.0.1,DNS:localhost`, '-keyout', key, '-out', cert], { stdio: 'ignore' })
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
  const script = await walletBundle()
  const wallet = process.env.ANMELDUNG_WALLET === 'app' ? 'app' : 'demo'
  // behind a public https tunnel or proxy: the web app calls itself by that address, the tunnel ends
  // TLS, so the server speaks plain http on its port and needs no certificate of its own
  const tunnel = process.env.PUBLIC_ORIGIN
  if (tunnel !== undefined) {
    if (!/^https:\/\/[^/]+$/.test(tunnel)) throw new Error('PUBLIC_ORIGIN must be an https origin, e.g. https://xyz.trycloudflare.com')
    await serve({ port, host: '0.0.0.0', publicOrigin: tunnel, walletScript: async () => script, wallet })
    console.log(`\nBeispiel-Web-App läuft: ${tunnel} → http://0.0.0.0:${port} (Wallet: ${wallet === 'app' ? 'Web-of-Trust-App über https://web-of-trust.de/a' : 'Demo-Seite'})\n`)
    console.log('Den Tunnel auf diesen Port richten; QR-Code und Antwortadresse nennen die öffentliche Adresse. Beenden mit Strg+C.\n')
    return
  }
  const host = lanAddress()
  const origin = `https://${host}:${port}`
  await serve({ port, host: '0.0.0.0', https: certificate(host), publicOrigin: origin, walletScript: async () => script, wallet })
  console.log(`\nBeispiel-Web-App läuft: ${origin} (Wallet: ${wallet === 'app' ? 'Web-of-Trust-App über https://web-of-trust.de/a' : 'Demo-Seite'})\n`)
  console.log('Laptop: diese Adresse im Browser öffnen, Warnung zum Zertifikat einmal bestätigen,')
  console.log('        „Mit dem Telefon anmelden“, QR-Code mit der Kamera des Telefons scannen.')
  console.log('Telefon: dieselbe Adresse im Browser öffnen, „Auf diesem Gerät anmelden“.')
  console.log('Beide Geräte im selben Netz. Beenden mit Strg+C.\n')
}
