/**
 * The distilled search index and the matching that runs against it.
 *
 * Everything here is synchronous and allocation-light: a search runs on the
 * main thread between a keypress and the next paint, over a few thousand
 * terms. All four matchers return S3 keys, which are also the manifest's
 * keys -- the index positions the postings use never escape this module.
 */
import { normalize } from "./tokenize";
import type { Item } from "../types";

export interface SearchIndex {
  /** Asset keys. Postings index into this. */
  keys: string[];
  /** Distinct lowercased labels, one entry per posting list. */
  labelTerms: string[];
  /** `labelTerms.length + 1` entries; list `t` spans `[offsets[t], offsets[t+1])`. */
  labelOffsets: Uint32Array;
  /** Indices into `keys`, grouped by term. */
  labelPostings: Uint32Array;
  /** Indices into `keys`, parallel to `ocrText`. */
  ocrKeys: Uint32Array;
  /** Normalized token strings, parallel to `ocrKeys`. */
  ocrText: string[];
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
 * Assets carrying a label that contains [term] as a whole word.
 *
 * Padding both the label and the term with spaces and asking for a substring
 * is the SQL `' ' || LOWER(label) || ' ' LIKE '% term %'` trick: labels are
 * space-delimited phrases, so this matches "passenger train" for "train"
 * while refusing to match inside "strainer".
 */
export function matchLabels(index: SearchIndex, term: string): Set<string> {
  const out = new Set<string>();
  const trimmed = term.trim().toLowerCase();
  if (trimmed === "") return out;

  const needle = ` ${trimmed} `;
  for (let t = 0; t < index.labelTerms.length; t++) {
    if (!` ${index.labelTerms[t]!} `.includes(needle)) continue;
    const start = index.labelOffsets[t]!;
    const end = index.labelOffsets[t + 1]!;
    for (let p = start; p < end; p++) out.add(index.keys[index.labelPostings[p]!]!);
  }
  return out;
}

/**
 * Assets whose OCR text contains [query] as an adjacent run of tokens.
 *
 * This is FTS5's `MATCH "phrase"` reproduced without FTS5. Both sides are
 * normalized to space-separated tokens, so a padded substring test is exactly
 * phrase matching: "cats sat" hits, "the sat" does not, and "cat" does not
 * prefix-match "cats". Characters that would be FTS5 query syntax are just
 * separators here, so a query containing them degrades to no matches instead
 * of throwing a syntax error.
 */
export function matchOcr(index: SearchIndex, query: string): Set<string> {
  const out = new Set<string>();
  const phrase = normalize(query);
  if (phrase === "") return out;

  const needle = ` ${phrase} `;
  for (let i = 0; i < index.ocrText.length; i++) {
    if (` ${index.ocrText[i]!} `.includes(needle)) out.add(index.keys[index.ocrKeys[i]!]!);
  }
  return out;
}

/**
 * Assets whose filename contains [query].
 *
 * Reads the manifest rather than the index: the manifest already holds every
 * key, and it is authoritative about what can actually be rendered. Only the
 * name is searched -- matching the path would make every query for a year
 * return that whole year.
 */
export function matchNames(items: Item[], query: string): Set<string> {
  const out = new Set<string>();
  const needle = query.trim().toLowerCase();
  if (needle === "") return out;

  for (const item of items) {
    const name = item.key.slice(item.key.lastIndexOf("/") + 1);
    if (name.toLowerCase().includes(needle)) out.add(item.key);
  }
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
