/**
 * The two Google calls: translate a query to English, and embed it.
 *
 * Both return null on ANY failure and never throw. Search proceeds without
 * them: a missing translation costs bilingual label matching, a missing
 * embedding costs semantic suggestions, and neither breaks a search.
 *
 * SECURITY: never log a caught error object from either call. Both request
 * URIs carry `?key=<apiKey>`, and an Error's string form embeds the URI it
 * failed on. Log `error.name` if anything at all.
 */
import { EMBEDDING_MODEL } from "./suggest";

const TRANSLATE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
const EMBED_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const CACHE_TTL_MS = 600_000;
const DIMENSIONS = 768;

/**
 * Hardcoded rather than auto-detected. Cloud Translation's detection is
 * unreliable on short context-free words -- "kat" comes back "at", "bil"
 * comes back "was" -- because there is no sentence to disambiguate against.
 * The cost is occasionally mistranslating an already-English query as if it
 * were Danish ("tent" -> "lit"), which rarely coincides with a real label
 * and is covered anyway by the untranslated pass that always runs.
 */
const SOURCE_LANGUAGE = "da";

interface CacheEntry<T> {
  value: T;
  at: number;
}

const translations = new Map<string, CacheEntry<string>>();
const embeddings = new Map<string, CacheEntry<number[]>>();

/** Drops both caches. Used by tests and by "forget credentials". */
export function clearGoogleCaches(): void {
  translations.clear();
  embeddings.clear();
}

function cached<T>(store: Map<string, CacheEntry<T>>, key: string, now: number): T | undefined {
  const entry = store.get(key);
  if (entry === undefined) return undefined;
  if (now - entry.at >= CACHE_TTL_MS) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * [query] in English, lowercased, or null. Memoised for ten minutes on the
 * lowercased query, so repeat and typo-corrected searches don't re-pay it.
 * Failures are not cached.
 */
export async function translateQuery(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string | null> {
  const cacheKey = query.toLowerCase();
  const hit = cached(translations, cacheKey, now());
  if (hit !== undefined) return hit;

  try {
    const response = await fetchImpl(`${TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ q: query, source: SOURCE_LANGUAGE, target: "en" }).toString(),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      data?: { translations?: Array<{ translatedText?: unknown }> };
    };
    const text = body.data?.translations?.[0]?.translatedText;
    if (typeof text !== "string") return null;

    const translated = text.trim().toLowerCase();
    translations.set(cacheKey, { value: translated, at: now() });
    return translated;
  } catch {
    // Deliberately swallowed without logging the error: see the file header.
    return null;
  }
}

/**
 * A 768-dimension embedding of [query], or null. Same caching contract as
 * [translateQuery].
 */
export async function embedQuery(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<number[] | null> {
  const cacheKey = query.toLowerCase();
  const hit = cached(embeddings, cacheKey, now());
  if (hit !== undefined) return hit;

  try {
    const url = `${EMBED_ENDPOINT}/${EMBEDDING_MODEL}:embedContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text: query }] },
        outputDimensionality: DIMENSIONS,
      }),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { embedding?: { values?: unknown } };
    const values = body.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) return null;
    if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return null;

    const vector = values as number[];
    embeddings.set(cacheKey, { value: vector, at: now() });
    return vector;
  } catch {
    // Deliberately swallowed without logging the error: see the file header.
    return null;
  }
}
