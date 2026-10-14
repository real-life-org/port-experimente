/* tslint:disable */
/* eslint-disable */

export class MlsPeer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Aufnahme: `{ op, welcome }`, op an alle, welcome an den Neuen.
     */
    add(_member_id: Uint8Array, share_key: Uint8Array): any;
    /**
     * Gründen: MLS erzeugt keine Operation für andere; leeres Array.
     */
    create(group: Uint8Array): Array<any>;
    static decryptWithKey(ciphertext: Uint8Array, key: Uint8Array): Uint8Array;
    decrypt(ciphertext: Uint8Array): any;
    /**
     * `{ ciphertext, updateOp: null, appKey }` wie bei BeeKEM; MLS rotiert beim Schreiben nicht.
     */
    encrypt(content_ref: Uint8Array, _pred_refs: Array<any>, plaintext: Uint8Array): any;
    /**
     * Aktuelle Epoche (0 ohne Gruppe).
     */
    epoch(): number;
    exportState(): Uint8Array;
    static fromState(bytes: Uint8Array): MlsPeer;
    hasKey(): boolean;
    members(): Array<any>;
    constructor();
    /**
     * Operation einspielen: "ok", "own" (eigenes Echo oder schon drin), "lost" (Tiebreak verloren, fremder Commit
     * gilt, eigener Zustand zurückgefallen), "stale" (nie mehr anwendbar) oder "reset" (Willkommen auf eine höhere
     * Epoche hat die eigene Gruppe ersetzt). Wirft, wenn sie noch nicht passt (Vorgänger fehlen).
     */
    receive(bytes: Uint8Array): any;
    remove(member_id: Uint8Array): any;
    rotate(): Uint8Array;
    readonly id: Uint8Array;
    readonly shareKey: Uint8Array;
}

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mlspeer_free: (a: number, b: number) => void;
    readonly mlspeer_add: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly mlspeer_create: (a: number, b: number, c: number) => [number, number, number];
    readonly mlspeer_decrypt: (a: number, b: number, c: number) => [number, number, number];
    readonly mlspeer_decryptWithKey: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly mlspeer_encrypt: (a: number, b: number, c: number, d: any, e: number, f: number) => [number, number, number];
    readonly mlspeer_epoch: (a: number) => number;
    readonly mlspeer_exportState: (a: number) => [number, number, number];
    readonly mlspeer_fromState: (a: number, b: number) => [number, number, number];
    readonly mlspeer_hasKey: (a: number) => number;
    readonly mlspeer_id: (a: number) => any;
    readonly mlspeer_members: (a: number) => any;
    readonly mlspeer_new: () => [number, number, number];
    readonly mlspeer_receive: (a: number, b: number, c: number) => [number, number, number];
    readonly mlspeer_remove: (a: number, b: number, c: number) => [number, number, number];
    readonly mlspeer_rotate: (a: number) => [number, number, number];
    readonly mlspeer_shareKey: (a: number) => any;
    readonly start: () => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
