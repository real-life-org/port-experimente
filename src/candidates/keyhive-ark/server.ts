// Nur Node: startet einen lokalen Subduction-Server (Rust, Ink & Switch) aus
// .cache/, wie ihn `scripts/fetch-subduction.sh` ablegt. Alle Node-Module
// werden dynamisch geladen, damit der Browser-Build den Kandidaten nicht zieht.

export const SUBDUCTION_VERSION = '0.18.0'

export interface RunningSubduction {
  readonly url: string
  /** Verifying key des Servers, 64 Hex-Zeichen (aus der Ready-Datei). */
  readonly peerIdHex: string
  stop(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Freien Port suchen. Der Server hasht seinen Socket-String als Service-Namen
 * für den Handshake, der Client den Host der URL; beide müssen gleich lauten,
 * also kein Port 0.
 */
async function freePort(): Promise<number> {
  const { createServer } = await import(/* @vite-ignore */ 'node:net')
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

export async function startSubduction(): Promise<RunningSubduction> {
  const [{ spawn }, fs, { tmpdir }, { join }] = await Promise.all([
    import(/* @vite-ignore */ 'node:child_process'),
    import(/* @vite-ignore */ 'node:fs'),
    import(/* @vite-ignore */ 'node:os'),
    import(/* @vite-ignore */ 'node:path'),
  ])
  const bin = join(process.cwd(), '.cache', `subduction-${SUBDUCTION_VERSION}`)
  if (!fs.existsSync(bin)) throw new Error(`Subduction-Server fehlt: ${bin}. Holen mit: sh scripts/fetch-subduction.sh`)
  const dir = fs.mkdtempSync(join(tmpdir(), 'subduction-'))
  const ready = join(dir, 'ready.txt')
  const port = await freePort()
  // Fester Seed: Die Identität des Servers ist je Lauf gleich, seine Kontaktkarte
  // (mit zufälligen Pre-Keys) trotzdem jedes Mal neu; sie wird über die Leitung geholt.
  const proc = spawn(bin, ['server', '--socket', `127.0.0.1:${port}`, '--data-dir', join(dir, 'data'), '--key-seed', '00'.repeat(31) + '01', '--ready-file', ready], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout?.on('data', (d: Buffer) => (log += d))
  proc.stderr?.on('data', (d: Buffer) => (log += d))
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await sleep(50)
  if (!fs.existsSync(ready)) {
    proc.kill()
    throw new Error('Subduction-Server nicht bereit:\n' + log.slice(-2000))
  }
  const kv = Object.fromEntries(fs.readFileSync(ready, 'utf8').trim().split('\n').map((l) => l.split('=') as [string, string]))
  return {
    url: `ws://127.0.0.1:${kv.port}`,
    peerIdHex: kv.peer_id!,
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise<void>((r) => proc.once('exit', () => r()))
        proc.kill('SIGTERM')
        await Promise.race([exited, sleep(2000)])
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
