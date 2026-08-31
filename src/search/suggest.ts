/**
 * "Did you mean" scoring. Advisory only: this produces candidate label
 * strings, never assets. The user picks one and it is re-searched through
 * the deterministic path, so a wrong suggestion costs a click, not a wrong
 * result set.
 */

/** Only rows written by this model are comparable with a query vector. */
export const EMBEDDING_MODEL = "gemini-embedding-001";

const THRESHOLD = 0.5;
const LIMIT = 5;

export interface Embeddings {
  labels: string[];
  /** `labels.length * dims` values; label `i` spans `[i * dims, (i+1) * dims)`. */
  vectors: Float32Array;
  dims: number;
  model: string;
}

export interface Scored {
  label: string;
  score: number;
}

export interface Suggestion {
  /** Shown on the chip; may carry a country qualifier. */
  display: string;
  /** Resubmitted verbatim when the chip is tapped. Never qualified. */
  query: string;
}

/** Cosine similarity of [a] against `dims` values of [b] starting at [bFrom]. */
export function cosine(a: ArrayLike<number>, bFrom: number, b: ArrayLike<number>, dims: number): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < dims; i++) {
    const x = a[i] ?? 0;
    const y = b[bFrom + i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Every label scored against [queryVec], highest first. */
export function scoreLabels(embeddings: Embeddings, queryVec: number[]): Scored[] {
  // import.ts already filters by model when building the index, but that
  // index is only rebuilt when the snapshot's lastModified changes -- not
  // when this build's EMBEDDING_MODEL does. Without this check, a future
  // model change at the same dimensionality would silently score new query
  // vectors against stale label vectors forever, since the length check
  // below would not catch it.
  if (embeddings.model !== EMBEDDING_MODEL) return [];

  // A query vector of another dimensionality can't be compared with anything
  // in the store. Bail rather than produce meaningless scores.
  if (queryVec.length !== embeddings.dims) return [];

  const scored: Scored[] = [];
  for (let i = 0; i < embeddings.labels.length; i++) {
    scored.push({
      label: embeddings.labels[i]!,
      score: cosine(queryVec, i * embeddings.dims, embeddings.vectors, embeddings.dims),
    });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored;
}

/**
 * The better of two independent passes, thresholded and capped.
 *
 * A Danish word has no relationship to an English embedding space until it
 * is translated, so a same-threshold hit found only by the untranslated pass
 * is lexical coincidence -- the reference records Danish "telt" ranking
 * "elk" and "telephone" above "tent". Once the translated pass finds a
 * closer neighbour it is the more trustworthy of the two and wins outright.
 * The loser is discarded, never merged: diluting the winner with the loser's
 * matches reintroduces exactly the noise this rule exists to remove.
 */
export function pickPass(untranslated: Scored[], translated: Scored[]): string[] {
  const bestOf = (pass: Scored[]): number => pass[0]?.score ?? -1;
  const winner = bestOf(translated) > bestOf(untranslated) ? translated : untranslated;
  return winner
    .filter((s) => s.score >= THRESHOLD)
    .slice(0, LIMIT)
    .map((s) => s.label);
}

/**
 * Places first, then labels, deduplicated on what would be resubmitted.
 *
 * Labels have no display/query distinction, so both fields are the label.
 */
export function mergeSuggestions(places: Suggestion[], labels: string[]): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const suggestion of [...places, ...labels.map((l) => ({ display: l, query: l }))]) {
    const queryLower = suggestion.query.toLowerCase();
    if (seen.has(queryLower)) continue;
    seen.add(queryLower);
    out.push(suggestion);
  }
  return out;
}
