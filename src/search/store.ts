/**
 * Persistence for the import's records. Five keys in one object store:
 * `index`, `embeddings`, `assets`, `snapshot` and `apikey`.
 *
 * `index` and `assets` are loaded at boot -- about 1 MB each, and search and
 * layout need them synchronously. `embeddings` is ten times that and is only
 * ever read when a search returns nothing, so it loads lazily and a session
 * that never misses never pays for it.
 */
import { getSearch, putSearchAll } from "../db";
import { isAssetTable } from "../assets";
import type { AssetTable } from "../assets";
import { INDEX_FORMAT } from "./local";
import type { Embeddings } from "./suggest";
import type { SearchIndex } from "./local";
import type { ImportResult } from "./import";

const INDEX = "index";
const EMBEDDINGS = "embeddings";
const ASSETS = "assets";
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
    [ASSETS, result.assets],
    [API_KEY, result.apiKey],
    [SNAPSHOT, lastModified],
  ]);
}

/**
 * Whether a stored record is an index this build can search.
 *
 * The store is a plain key/value bag with no schema, and a viewer upgraded
 * over an older one finds whatever that one wrote still sitting there. The
 * pre-migration record has separate label and OCR columns and no `format` at
 * all, so it reads as absent and the boot sequence imports over it rather
 * than handing `matchTokens` an index whose `terms` array does not exist.
 *
 * Structured clone preserves typed arrays, so a record written by this build
 * comes back with its `Uint32Array`s intact; anything else did not come from
 * `saveImport` and is not trusted.
 */
export function isCurrentIndex(value: unknown): value is SearchIndex {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SearchIndex>;
  return (
    candidate.format === INDEX_FORMAT &&
    Array.isArray(candidate.keys) &&
    Array.isArray(candidate.terms) &&
    candidate.offsets instanceof Uint32Array &&
    candidate.postings instanceof Uint32Array &&
    candidate.geoKeys instanceof Uint32Array &&
    candidate.geoLat instanceof Float64Array &&
    candidate.geoLon instanceof Float64Array
  );
}

/**
 * The stored index, or null when there is none this build can search.
 *
 * The boot sequence pairs this with {@link getSnapshot}: a stored
 * `lastModified` with no index behind it -- which is what an upgrade across
 * the index format looks like -- has to count as nothing stored, or the
 * unchanged `lastModified` would suppress the re-import forever. Boot and the
 * search box share one call, because deserializing about 1 MB of typed arrays
 * twice at startup buys nothing.
 */
export async function loadIndex(): Promise<SearchIndex | null> {
  const stored = await getSearch<unknown>(INDEX);
  return isCurrentIndex(stored) ? stored : null;
}

/**
 * The stored asset table, or null when there is none. An import from before
 * the table existed left the other records but not this one, and the boot
 * sequence treats that like a missing index: import again.
 */
export async function loadAssets(): Promise<AssetTable | null> {
  const stored = await getSearch<unknown>(ASSETS);
  return isAssetTable(stored) ? stored : null;
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
