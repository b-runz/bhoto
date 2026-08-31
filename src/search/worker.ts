/**
 * Imports a snapshot, off the main thread.
 *
 * A CLASSIC worker, not a module worker: sql.js is a UMD bundle reached
 * through importScripts, which module workers do not have. That is why
 * package.json builds this entry with --format iife.
 *
 * The worker receives a presigned URL and never sees credentials. Everything
 * it allocates -- the 19 MB download, the 54 MB database, sql.js itself --
 * dies with it, which is the point of doing this here.
 */
import { buildIndex } from "./import";
import { maybeGunzip } from "./gunzip";
import type { InitSqlJs } from "./sqljs";

declare const initSqlJs: InitSqlJs;

declare function importScripts(...urls: string[]): void;

interface WorkerScope {
  onmessage: ((event: MessageEvent<ImportRequest>) => void) | null;
  postMessage(message: unknown): void;
}

const ctx = self as unknown as WorkerScope;

importScripts("./sql-wasm.js");

interface ImportRequest {
  url: string;
}

ctx.onmessage = (event: MessageEvent<ImportRequest>): void => {
  void run(event.data.url);
};

async function run(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`snapshot download failed: HTTP ${response.status}`);

    const bytes = await download(response);
    const db = new (await initSqlJs({ locateFile: (file) => file })).Database(await maybeGunzip(bytes));
    try {
      // Structured clone copies the typed arrays; no transfer list, because
      // the worker is about to be terminated anyway.
      ctx.postMessage({ type: "done", result: buildIndex(db) });
    } finally {
      db.close();
    }
  } catch (error) {
    // Safe to surface: none of the errors thrown here embed the request URL
    // (a presigned S3 URL carrying X-Amz-Signature) the way a caught fetch
    // error's string form can, and the main thread discards this message
    // text anyway -- see importSnapshot in main.ts.
    ctx.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Reads the body, reporting progress. `total` is 0 when unknown. */
async function download(response: Response): Promise<Uint8Array> {
  const total = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(await response.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    ctx.postMessage({ type: "progress", loaded, total });
  }

  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
