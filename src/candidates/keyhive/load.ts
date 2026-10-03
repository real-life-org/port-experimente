// @keyhive/keyhive über den „slim“-Einstieg: WebAssembly explizit laden,
// im Browser per URL, in Node aus der Datei.
// @ts-expect-error slim exportiert den Init-Standard ohne Typen (bekannte Lücke im Paket)
import init, { initSync } from '@keyhive/keyhive/slim'
import wasmUrl from '@keyhive/keyhive/wasm?url'

let ready: Promise<void> | undefined

export function loadKeyhive(): Promise<void> {
  ready ??= (async () => {
    const node = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined'
    if (node) {
      const { readFile } = await import(/* @vite-ignore */ 'node:fs/promises')
      const { createRequire } = await import(/* @vite-ignore */ 'node:module')
      const path = createRequire(import.meta.url).resolve('@keyhive/keyhive/wasm')
      initSync({ module: await readFile(path) })
    } else {
      await init({ module_or_path: wasmUrl })
    }
  })()
  return ready
}
