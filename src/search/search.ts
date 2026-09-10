/**
 * Orchestration. Runs the local passes against the in-memory index while the
 * network passes are in flight, merges what arrives in time, and intersects
 * the result with the manifest.
 *
 * Every dependency is injected: this module has no network, no DOM and no
 * storage of its own, which is what makes the whole search path testable.
 */
import { matchTokens, pointsInBox } from "./local";
import { containsPoint, matchesExactName } from "./nominatim";
import { mergeSuggestions, pickPass, scoreLabels } from "./suggest";
import type { SearchIndex } from "./local";
import type { NominatimPlace } from "./nominatim";
import type { Embeddings, Suggestion } from "./suggest";
import type { Item } from "../types";

/**
 * Nominatim matches word prefixes, so a shorter query is too likely to
 * spuriously prefix-match a real place ("cat" -> Catalunya) to be worth
 * sending at all.
 */
const MIN_PLACE_QUERY = 3;
const DEFAULT_TIMEOUT_MS = 3000;
const PLACE_SUGGESTION_LIMIT = 5;

export interface PlaceOptions {
  addressDetails?: boolean;
  acceptLanguage?: string;
}

export interface SearchDeps {
  index: SearchIndex;
  /** The manifest. Authoritative about what can be rendered. */
  items: Item[];
  translate: (query: string) => Promise<string | null>;
  places: (query: string, options?: PlaceOptions) => Promise<NominatimPlace[]>;
  embed: (query: string) => Promise<number[] | null>;
  embeddings: () => Promise<Embeddings | null>;
  timeoutMs?: number;
}

/** Resolves to [fallback] if [promise] hasn't settled in time. Never rejects. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Keys matching [query]. Never throws. */
export async function runSearch(query: string, deps: SearchDeps): Promise<Set<string>> {
  const trimmed = query.trim();
  if (trimmed === "") return new Set();

  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Both network passes start before the local ones, so the local work
  // overlaps their latency instead of following it.
  const placePass = within(placeMatches(trimmed, deps), timeout, new Set<string>());
  const translation = within(deps.translate(trimmed), timeout, null);

  // One pass over one inverted index covers every searchable column --
  // labels, OCR text, filenames and camera text alike. There is no separate
  // filename pass over the manifest any more: `name_normalized` is indexed
  // like everything else.
  const found = matchTokens(deps.index, trimmed);

  // The translated term goes through the same token match as the raw one, and
  // its hits are unioned in: a Danish label and an English one are both
  // legitimate answers to the same query. Deterministic either way -- a token
  // is in the index or it is not.
  const translated = await translation;
  if (translated !== null && translated !== "" && translated !== trimmed.toLowerCase()) {
    for (const key of matchTokens(deps.index, translated)) found.add(key);
  }

  for (const key of await placePass) found.add(key);

  // The manifest is what can actually be drawn. This is where assets deleted
  // on the phone, or gone from the bucket, fall away.
  const renderable = new Set(deps.items.map((item) => item.key));
  const out = new Set<string>();
  for (const key of found) if (renderable.has(key)) out.add(key);
  return out;
}

/** Geotagged assets inside the place [query] names exactly. */
async function placeMatches(query: string, deps: SearchDeps): Promise<Set<string>> {
  const out = new Set<string>();
  if (query.length < MIN_PLACE_QUERY) return out;

  const candidates = await deps.places(query);
  const place = candidates.find((candidate) => matchesExactName(candidate, query));
  if (place === undefined || place.boundingBox === null) return out;

  const [south, north, west, east] = place.boundingBox;
  for (const point of pointsInBox(deps.index, south, north, west, east)) {
    // null means there is no polygon to test, and the box stands alone.
    if (containsPoint(place, point.lat, point.lon) === false) continue;
    out.add(point.key);
  }
  return out;
}

/**
 * "Did you mean" candidates. Shown only when a search returned nothing, and
 * never blended into results -- the user picks one and it is re-searched
 * through the deterministic path.
 */
export async function suggestFor(query: string, deps: SearchDeps): Promise<Suggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_PLACE_QUERY) return [];

  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const places = within(placeSuggestions(trimmed, deps), timeout, [] as Suggestion[]);
  const labels = within(labelSuggestions(trimmed, deps), timeout, [] as string[]);

  return mergeSuggestions(await places, await labels);
}

async function placeSuggestions(query: string, deps: SearchDeps): Promise<Suggestion[]> {
  const candidates = await deps.places(query, { addressDetails: true, acceptLanguage: "en" });
  const typed = query.toLowerCase();
  const seen = new Set<string>();
  const out: Suggestion[] = [];

  for (const place of candidates) {
    const name = place.nameEn ?? place.name;
    if (name === null) continue;
    const lowered = name.toLowerCase();
    // The deterministic path already considered this one, and tapping it
    // would resubmit the identical string to the identical outcome.
    if (lowered === typed) continue;
    // Set.prototype.add always returns the Set (truthy), so `!seen.add(x)`
    // never fires -- an explicit has/add pair is required to dedupe.
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    out.push({
      display: place.country !== null ? `${name} (${place.country})` : name,
      query: name,
    });
    if (out.length >= PLACE_SUGGESTION_LIMIT) break;
  }
  return out;
}

async function labelSuggestions(query: string, deps: SearchDeps): Promise<string[]> {
  const embeddings = await deps.embeddings();
  if (embeddings === null || embeddings.labels.length === 0) return [];

  const rawVec = await deps.embed(query);
  const untranslated = rawVec === null ? [] : scoreLabels(embeddings, rawVec);

  let translatedScores: ReturnType<typeof scoreLabels> = [];
  const translated = await deps.translate(query);
  if (translated !== null && translated !== "" && translated !== query.toLowerCase()) {
    const vec = await deps.embed(translated);
    if (vec !== null) translatedScores = scoreLabels(embeddings, vec);
  }

  return pickPass(untranslated, translatedScores);
}
