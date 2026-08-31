/**
 * Persistence for the search records. Four keys in one object store:
 * `index`, `embeddings`, `snapshot` and `apikey`.
 *
 * `index` is loaded at boot -- about 1 MB, and search needs it synchronously.
 * `embeddings` is ten times that and is only ever read when a search returns
 * nothing, so it loads lazily and a session that never misses never pays for
 * it.
 */
import { getSearch, putSearchAll } from "../db";
import type { Embeddings } from "./suggest";
import type { SearchIndex } from "./local";
import type { ImportResult } from "./import";

const INDEX = "index";
const EMBEDDINGS = "embeddings";
const SNAPSHOT = "snapshot";
const API_KEY = "apikey";

/** `lastModified` of the snapshot this index was built from, in epoch ms. */
export async function getSnapshot(): Promise<number | null> {
  const value = await getSearch<number>(SNAPSHOT);
  return typeof value === "number" ? value : null;
}

/**
 * Writes an import in one transaction. The transaction's all-or-nothing
 * atomicity ensures a failure cannot leave a stale index labelled current.
 */
export function saveImport(result: ImportResult, lastModified: number): Promise<void> {
  return putSearchAll([
    [INDEX, result.index],
    [EMBEDDINGS, result.embeddings],
    [API_KEY, result.apiKey],
    [SNAPSHOT, lastModified],
  ]);
}

export async function loadIndex(): Promise<SearchIndex | null> {
  return (await getSearch<SearchIndex>(INDEX)) ?? null;
}

export async function loadEmbeddings(): Promise<Embeddings | null> {
  return (await getSearch<Embeddings>(EMBEDDINGS)) ?? null;
}

/**
 * The API key the phone stored, unwrapped from the JSON it is kept in
 * (`{"apiKey":"..."}`). Null when absent or malformed.
 */
export async function loadApiKey(): Promise<string | null> {
  const raw = await getSearch<string | null>(API_KEY);
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    return typeof parsed.apiKey === "string" && parsed.apiKey !== "" ? parsed.apiKey : null;
  } catch {
    return null;
  }
}
