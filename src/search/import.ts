/**
 * Turns a snapshot of the phone's metadata DB into the distilled search
 * index. Runs once per new snapshot, inside a Worker.
 *
 * Every query joins remote_asset_entity on `deleted_at IS NULL`. That join is
 * not decoration: much of each table belongs to phone-local assets this app
 * cannot render, and asset_fts_content.c0 in particular is a phone-local
 * numeric ID for hundreds of rows. Without the join the OCR index would
 * carry entries nothing can ever match.
 */
import { normalize } from "./tokenize";
import { EMBEDDING_MODEL } from "./suggest";
import type { Embeddings } from "./suggest";
import type { SearchIndex } from "./local";
import type { SqlDatabase, SqlValue } from "./sqljs";

/** Vectors are Float32 in the DB; 3072 bytes is 768 dimensions. */
const DIMENSIONS = 768;

export interface ImportResult {
  index: SearchIndex;
  embeddings: Embeddings;
  /** The raw JSON from store_entity 2002, or null. Parsed by the caller. */
  apiKey: string | null;
}

function rows(db: SqlDatabase, sql: string): SqlValue[][] {
  const stmt = db.prepare(sql);
  const out: SqlValue[][] = [];
  try {
    while (stmt.step()) out.push(stmt.get());
  } finally {
    stmt.free();
  }
  return out;
}

export function buildIndex(db: SqlDatabase): ImportResult {
  // ---- keys -------------------------------------------------------------
  const keys: string[] = [];
  const keyIndex = new Map<string, number>();
  for (const row of rows(
    db,
    "SELECT id FROM remote_asset_entity WHERE deleted_at IS NULL ORDER BY id",
  )) {
    const key = String(row[0]);
    keyIndex.set(key, keys.length);
    keys.push(key);
  }

  // ---- labels -----------------------------------------------------------
  // Grouped in JS rather than by SQL, because the posting lists have to come
  // out contiguous and in term order to be addressable by offsets.
  const byTerm = new Map<string, number[]>();
  for (const row of rows(
    db,
    `SELECT DISTINCT LOWER(l.label) AS term, l.asset_id
       FROM asset_label_entity l
       JOIN remote_asset_entity r ON r.id = l.asset_id
      WHERE r.deleted_at IS NULL`,
  )) {
    const term = String(row[0]);
    const at = keyIndex.get(String(row[1]));
    if (at === undefined) continue;
    const list = byTerm.get(term);
    if (list === undefined) byTerm.set(term, [at]);
    else list.push(at);
  }

  const labelTerms = [...byTerm.keys()].sort();
  const labelOffsets = new Uint32Array(labelTerms.length + 1);
  let total = 0;
  for (let t = 0; t < labelTerms.length; t++) {
    labelOffsets[t] = total;
    total += byTerm.get(labelTerms[t]!)!.length;
  }
  labelOffsets[labelTerms.length] = total;

  const labelPostings = new Uint32Array(total);
  let cursor = 0;
  for (const term of labelTerms) {
    for (const at of byTerm.get(term)!) labelPostings[cursor++] = at;
  }

  // ---- OCR --------------------------------------------------------------
  const ocrKeyList: number[] = [];
  const ocrText: string[] = [];
  for (const row of rows(
    db,
    `SELECT f.c0 AS asset_id, f.c1 AS ocr_text
       FROM asset_fts_content f
       JOIN remote_asset_entity r ON r.id = f.c0
      WHERE r.deleted_at IS NULL AND f.c1 IS NOT NULL AND f.c1 <> ''`,
  )) {
    const at = keyIndex.get(String(row[0]));
    if (at === undefined) continue;
    const text = normalize(String(row[1]));
    if (text === "") continue;
    ocrKeyList.push(at);
    ocrText.push(text);
  }

  // ---- geo --------------------------------------------------------------
  const geoKeyList: number[] = [];
  const lats: number[] = [];
  const lons: number[] = [];
  for (const row of rows(
    db,
    `SELECT e.asset_id, e.latitude, e.longitude
       FROM remote_exif_entity e
       JOIN remote_asset_entity r ON r.id = e.asset_id
      WHERE r.deleted_at IS NULL
        AND e.latitude IS NOT NULL AND e.longitude IS NOT NULL`,
  )) {
    const at = keyIndex.get(String(row[0]));
    if (at === undefined) continue;
    const lat = Number(row[1]);
    const lon = Number(row[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    geoKeyList.push(at);
    lats.push(lat);
    lons.push(lon);
  }

  // ---- embeddings -------------------------------------------------------
  // Restricted to labels that survived the join. The rest belong only to
  // phone-local assets, so suggesting one produces a chip that dead-ends at
  // zero results. A small, deliberate divergence from the reference.
  const live = new Set(labelTerms);
  const embeddingLabels: string[] = [];
  const vectorChunks: Float32Array[] = [];
  for (const row of rows(
    db,
    `SELECT label, embedding FROM label_embedding_entity
      WHERE model = '${EMBEDDING_MODEL}'`,
  )) {
    const label = String(row[0]).toLowerCase();
    if (!live.has(label)) continue;
    const blob = row[1];
    if (!(blob instanceof Uint8Array) || blob.length !== DIMENSIONS * 4) continue;
    // Copy rather than view: the blob's byteOffset need not be 4-aligned,
    // and the result has to survive structured clone into IndexedDB.
    const vector = new Float32Array(DIMENSIONS);
    new Uint8Array(vector.buffer).set(blob);
    embeddingLabels.push(label);
    vectorChunks.push(vector);
  }

  const vectors = new Float32Array(embeddingLabels.length * DIMENSIONS);
  vectorChunks.forEach((chunk, i) => vectors.set(chunk, i * DIMENSIONS));

  // ---- API key ----------------------------------------------------------
  const keyRows = rows(db, "SELECT string_value FROM store_entity WHERE id = 2002");
  const rawKey = keyRows[0]?.[0];
  const apiKey = typeof rawKey === "string" && rawKey !== "" ? rawKey : null;

  return {
    index: {
      keys,
      labelTerms,
      labelOffsets,
      labelPostings,
      ocrKeys: Uint32Array.from(ocrKeyList),
      ocrText,
      geoKeys: Uint32Array.from(geoKeyList),
      geoLat: Float64Array.from(lats),
      geoLon: Float64Array.from(lons),
    },
    embeddings: {
      labels: embeddingLabels,
      vectors,
      dims: DIMENSIONS,
      model: EMBEDDING_MODEL,
    },
    apiKey,
  };
}
