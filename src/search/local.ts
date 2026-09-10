/**
 * The distilled search index and the matching that runs against it.
 *
 * One inverted index covers every column the phone used to search
 * separately (labels, OCR text, filenames): each row's text is folded into
 * tokens and every token gets one posting list, so a query is just a lookup
 * per token followed by an intersection. This reproduces a bare SQLite
 * FTS5 `MATCH` over multiple columns -- implicit AND between tokens, no
 * prefix matching, no substring matching, and no awareness of which column a
 * token came from. See the "Index shape" section of
 * `docs/superpowers/specs/2026-09-09-unified-model-migration-design.md` for
 * why the four-matcher design this replaces doesn't reflect what FTS5
 * actually does.
 *
 * Everything here is synchronous and allocation-light: a search runs on the
 * main thread between a keypress and the next paint, over a few thousand
 * terms.
 */
import { fold } from "./tokenize";

export const INDEX_FORMAT = 2;

export interface SearchIndex {
  /** Format version of a persisted index; equals {@link INDEX_FORMAT}. */
  format: number;
  /** Asset keys. Postings index into this. */
  keys: string[];
  /** Distinct folded tokens across every searchable column, sorted. */
  terms: string[];
  /** `terms.length + 1` entries; term `t`'s postings span `[offsets[t], offsets[t+1])`. */
  offsets: Uint32Array;
  /** Indices into `keys`, grouped by term, ascending within a term. */
  postings: Uint32Array;
  /** Indices into `keys`, parallel to `geoLat` and `geoLon`. */
  geoKeys: Uint32Array;
  geoLat: Float64Array;
  geoLon: Float64Array;
}

export interface GeoPoint {
  key: string;
  lat: number;
  lon: number;
}

/**
 * Binary-searches the sorted `terms` array for `term`, returning its index
 * or -1 if absent.
 */
function findTerm(terms: string[], term: string): number {
  let lo = 0;
  let hi = terms.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = terms[mid]!;
    if (candidate === term) return mid;
    if (candidate < term) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Assets matching every token in [query], reproducing a bare FTS5 `MATCH`
 * with its implicit AND across tokens and no prefix or substring matching.
 *
 * The query is folded with {@link fold} -- the phone's query folding, not
 * `normalize` -- then split on spaces. Each token is binary-searched in the
 * sorted `terms` array; any token absent from the index makes the whole
 * query empty without touching a single posting list. Otherwise the
 * matching tokens' posting lists are intersected, smallest first, so a rare
 * token prunes the search before a common one is ever scanned.
 *
 * Posting lists are ascending within a term, which would allow a
 * merge-style (two-pointer) intersection, but at the scale this runs at
 * (a few thousand terms, a keypress-to-paint budget) a plain `Set`
 * intersection is simpler to read and just as fast, so that's what this
 * does.
 */
export function matchTokens(index: SearchIndex, query: string): Set<string> {
  const folded = fold(query);
  if (folded === "") return new Set();

  const tokens = folded.split(" ");
  const termIndices: number[] = [];
  for (const token of tokens) {
    const t = findTerm(index.terms, token);
    if (t === -1) return new Set();
    termIndices.push(t);
  }

  // Intersect smallest posting list first, so a rare token prunes early.
  termIndices.sort(
    (a, b) =>
      index.offsets[a + 1]! - index.offsets[a]! - (index.offsets[b + 1]! - index.offsets[b]!),
  );

  let result: Set<number> | null = null;
  for (const t of termIndices) {
    const start = index.offsets[t]!;
    const end = index.offsets[t + 1]!;
    if (result === null) {
      result = new Set();
      for (let p = start; p < end; p++) result.add(index.postings[p]!);
      continue;
    }
    const next = new Set<number>();
    for (let p = start; p < end; p++) {
      const posting = index.postings[p]!;
      if (result.has(posting)) next.add(posting);
    }
    result = next;
    if (result.size === 0) break;
  }

  const out = new Set<string>();
  if (result !== null) for (const keyIndex of result) out.add(index.keys[keyIndex]!);
  return out;
}

/**
 * Geotagged assets inside a bounding box, inclusive at the edges to match
 * SQL `BETWEEN`.
 *
 * A coarse pre-filter only. For territory crossing the antimeridian the box
 * is the whole world, so the caller must still test the polygon.
 */
export function pointsInBox(
  index: SearchIndex,
  south: number,
  north: number,
  west: number,
  east: number,
): GeoPoint[] {
  const out: GeoPoint[] = [];
  for (let i = 0; i < index.geoKeys.length; i++) {
    const lat = index.geoLat[i]!;
    const lon = index.geoLon[i]!;
    if (lat < south || lat > north || lon < west || lon > east) continue;
    out.push({ key: index.keys[index.geoKeys[i]!]!, lat, lon });
  }
  return out;
}
