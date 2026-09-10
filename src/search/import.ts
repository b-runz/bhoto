/**
 * Turns a snapshot of the phone's metadata DB into the distilled search
 * index. Runs once per new snapshot, inside a Worker.
 *
 * Every statement filters `gallery_asset` on `remote_key <> '' AND
 * visibility = 0`. That filter is not decoration: it is the phone's own
 * filter for both `search` and `byLocation`, and much of the table belongs
 * to photos this app cannot render -- phone-local rows have no S3 key at
 * all, and archived, hidden and locked rows are not searchable even when
 * their objects are in the bucket. Without it the index would carry entries
 * nothing can ever display. There is no `deleted_at` in this schema: a
 * deleted photo has no row.
 *
 * Text goes through `normalize()`, never `fold()`. The two exist for the two
 * sides of the same search: the phone indexed its columns through FTS5's
 * `unicode61` tokenizer, which `normalize` emulates, and folds only the
 * user's *query* with `foldForSearch`, which `fold` ports. They agree on
 * ASCII and disagree on letters with no decomposition, so using `fold` here
 * would index `ærø` as `aero` and quietly break parity with the phone in
 * the other direction. Applying `normalize` to columns the phone already
 * folded is exact: `unicode61` on folded ASCII is the identity split.
 */
import { normalize } from "./tokenize";
import { EMBEDDING_MODEL } from "./suggest";
import type { Embeddings } from "./suggest";
import type { SearchIndex } from "./local";
import { INDEX_FORMAT } from "./local";
import type { SqlDatabase, SqlValue } from "./sqljs";

/** Vectors are Float32 in the DB; 3072 bytes is 768 dimensions. */
const DIMENSIONS = 768;

/** The phone's filter for a photo this viewer can render and search. */
const RENDERABLE = "remote_key <> '' AND visibility = 0";

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
  // SQLite's default BINARY collation is byte order, which agrees with the
  // code-unit order matchTokens' binary search over `keys` assumes.
  const keys: string[] = [];
  const keyIndex = new Map<string, number>();
  for (const row of rows(
    db,
    `SELECT remote_key FROM gallery_asset WHERE ${RENDERABLE} ORDER BY remote_key`,
  )) {
    const key = String(row[0]);
    keyIndex.set(key, keys.length);
    keys.push(key);
  }

  // ---- terms and postings -----------------------------------------------
  // One inverted index over all four searchable columns. Grouped in JS
  // rather than by SQL, because the posting lists have to come out
  // contiguous and in term order to be addressable by offsets. The per-row
  // Set is what makes a row appear once per distinct token however many
  // columns carried it -- position and column identity are not stored,
  // because a bare FTS5 match needs neither.
  const byTerm = new Map<string, number[]>();
  for (const row of rows(
    db,
    `SELECT remote_key, name_normalized, label_text, camera_text, ocr_text
       FROM gallery_asset WHERE ${RENDERABLE}`,
  )) {
    const at = keyIndex.get(String(row[0]));
    if (at === undefined) continue;
    const tokens = new Set<string>();
    for (let column = 1; column <= 4; column++) {
      const value = row[column];
      if (value === null || value === undefined) continue;
      const text = normalize(String(value));
      if (text === "") continue;
      for (const token of text.split(" ")) tokens.add(token);
    }
    for (const token of tokens) {
      const list = byTerm.get(token);
      if (list === undefined) byTerm.set(token, [at]);
      else list.push(at);
    }
  }

  // Plain .sort(): matchTokens binary-searches `terms` with `<` and `===`,
  // which is UTF-16 code-unit order. A locale-aware sort would order `ærø`
  // differently and silently make it unfindable.
  const terms = [...byTerm.keys()].sort();
  const offsets = new Uint32Array(terms.length + 1);
  let total = 0;
  for (let t = 0; t < terms.length; t++) {
    offsets[t] = total;
    total += byTerm.get(terms[t]!)!.length;
  }
  offsets[terms.length] = total;

  const postings = new Uint32Array(total);
  let cursor = 0;
  for (const term of terms) {
    // Ascending within a term, independent of the order the rows arrived in.
    for (const at of byTerm.get(term)!.sort((a, b) => a - b)) postings[cursor++] = at;
  }

  // ---- geo --------------------------------------------------------------
  // latitude and longitude are REAL NOT NULL defaulting to 0.0, so
  // has_location is what excludes an unlocated row, not a null test.
  const geoKeyList: number[] = [];
  const lats: number[] = [];
  const lons: number[] = [];
  for (const row of rows(
    db,
    `SELECT remote_key, latitude, longitude FROM gallery_asset
      WHERE ${RENDERABLE} AND has_location = 1`,
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
  // Restricted to labels carried by a renderable row. The rest belong only
  // to photos this app cannot show, so suggesting one produces a chip that
  // dead-ends at zero results. Read from gallery_label rather than from
  // `terms`, because a label is a whole phrase -- `passenger train` is one
  // embedding and two terms.
  const live = new Set<string>();
  for (const row of rows(
    db,
    `SELECT DISTINCT LOWER(l.label) FROM gallery_label l
       JOIN gallery_asset a ON a.checksum = l.checksum
      WHERE a.remote_key <> '' AND a.visibility = 0`,
  )) {
    live.add(String(row[0]));
  }

  const embeddingLabels: string[] = [];
  const vectorChunks: Float32Array[] = [];
  for (const row of rows(
    db,
    `SELECT label, embedding FROM label_embedding WHERE model = '${EMBEDDING_MODEL}'`,
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
  // store_entity predates the phone's Drift file and rides along in every
  // push, but the migration script builds the first snapshot from the asset
  // DDL alone. An absent table is a null key, not a failed import.
  let apiKey: string | null = null;
  const hasStore = rows(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'store_entity'",
  );
  if (hasStore.length > 0) {
    const keyRows = rows(db, "SELECT string_value FROM store_entity WHERE id = 2002");
    const rawKey = keyRows[0]?.[0];
    if (typeof rawKey === "string" && rawKey !== "") apiKey = rawKey;
  }

  return {
    index: {
      format: INDEX_FORMAT,
      keys,
      terms,
      offsets,
      postings,
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
