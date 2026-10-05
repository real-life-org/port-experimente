import init, { initSync, BeekemPeer } from './pkg/beekem_wasm.js'

let ready: Promise<void> | undefined

/** Lädt das WebAssembly-Modul einmal: im Browser per fetch, in Node aus der Datei. */
export function loadWasm(): Promise<void> {
  ready ??= (async () => {
    const node = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined'
    if (node) {
      const { readFile } = await import(/* @vite-ignore */ 'node:fs/promises')
      initSync({ module: await readFile(new URL('./pkg/beekem_wasm_bg.wasm', import.meta.url)) })
    } else {
      await init()
    }
  })()
  return ready
}

export { BeekemPeer }
