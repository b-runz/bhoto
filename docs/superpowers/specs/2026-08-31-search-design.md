# Search — Design

**Date:** 2026-08-31
**Status:** Approved for planning

Search over the photo library: filename, OCR text, ML labels, place names, and
an advisory "did you mean". Everything runs in the browser, as before. The data
comes from the metadata DB the phone already pushes to the bucket.

This is the feature the viewer's own design deferred: *"the storage schema
leaves room for labels, OCR text, lat/long and EXIF, but nothing shows them
yet."* Nothing about the schema changes to accommodate it.

## Scope

**In:** a search box in the gallery header that filters the grid in place;
matching on filename, OCR text, ML labels (in English and Danish), and place
name via geotag; "did you mean" suggestions when a search finds nothing.

**Out:** faces and people, albums, date filters, camera/EXIF filters, a
`SqliteProvider` for thumbnail dimensions, saved searches, search history.

## Reference implementation

This is a port, not a new design. The behaviour is defined by
`immich-mobile-with-history`:

| Concern | Source of truth |
|---|---|
| Query strategy, translation, suggestions | `lib/infrastructure/local_server/handlers/search_handler.dart` |
| Place lookup, polygon containment | `lib/utils/nominatim.dart` |
| When suggestions appear, chip behaviour | `lib/presentation/pages/search/drift_search.page.dart` |
| Snapshot keys and status file | `lib/services/db_sync.service.dart` |

Where this document says "same as the reference", it means the behaviour should
match observably, not that the code should be transliterated.

Two deliberate divergences, both forced by the medium:

1. **No `local_asset_entity` path.** The reference searches phone-local assets
   not yet uploaded. Nothing outside the bucket is renderable here, so that
   path is dropped rather than ported and left dead.
2. **Results filter the existing grid** rather than opening a search page. The
   app is one scrolling gallery; a second grid would be a second `Grid`, `Rail`
   and `Lightbox` for no visible gain.

## Prerequisites

Two, on top of the viewer's existing three.

1. **`.meta/s3immich.db.gz` and `.meta/db-status.json` in the bucket.** Written
   by the phone's `DbSyncService.push()`. Without them there is nothing to
   search; the box hides itself and says so.
2. **A Google API key,** for translation and embeddings. Optional — search
   works without it, minus bilingual label matching and semantic suggestions.

The bucket's existing CORS rule already covers both new objects. No change
there.

## CORS, verified

Checked against the live endpoints before any of this was designed, because a
browser can't work around a missing header and there is no server to proxy
through.

| Endpoint | Result |
|---|---|
| `.meta/*` on the bucket | Covered by the existing rule — `GET`/`HEAD`, `AllowedHeaders: ["*"]`. Same signed-fetch path listing already uses. |
| `nominatim.openstreetmap.org/search` | `access-control-allow-origin: *` on a real GET. |
| `translation.googleapis.com` | Preflight returns ACAO for the origin, `Allow-Methods` including POST, `Allow-Headers: content-type`. The POST echoes ACAO. |
| `generativelanguage.googleapis.com` | **Unverified.** See below. |

**Nominatim must stay a simple request.** Its `OPTIONS` returns a 302, so any
custom header — including the `User-Agent` the Dart code sets, which browsers
forbid anyway — triggers a preflight that fails. The browser's own `User-Agent`
and `Referer` satisfy the usage policy. Send no headers.

**Gemini could not be verified.** `generativelanguage.googleapis.com` refuses
the TLS handshake from the development machine (`SEC_E_ILLEGAL_MESSAGE` from
curl, `SSLV3_ALERT_HANDSHAKE_FAILURE` from Python) — the connection dies before
any HTTP happens, while `translation.googleapis.com` on the same Google
frontend works fine. That reads as a network policy block on the generative-AI
domain, not a CORS problem, and CORS is very likely fine. But it is unproven,
and if the block also applies wherever the page is served, semantic suggestions
will not work and there is no fallback.

The design absorbs this rather than depending on it: both Google calls return
`null` on any failure and search proceeds without them, exactly as the
reference does.

## The API key

`GcvConfig.save()` writes the key to Drift's `store_entity` (id `2002`) as well
as to secure storage, and `store_entity` ships inside `s3immich.db.gz`. **The
key is therefore already in the bucket**, and is already readable by anyone
with read access to it. That is true today, independent of this feature.

Resolution order, mirroring the reference's own layered `GcvConfig.load()`:

1. The optional **Google API key** field in the setup form, if set.
2. Otherwise `store_entity` id `2002` from the imported snapshot.
3. Otherwise no key — the two Google-dependent features stay dark.

Prefer (1) in practice. A key used from a browser can carry an **HTTP referrer
restriction** scoped to the app's origin, which a key used by the Flutter app
cannot — the app authenticates as an Android/iOS application. One key cannot be
both, so restricting the browser's access means minting a second key.

The key ends up in IndexedDB and in a URL query string either way. Two
consequences, both non-negotiable in the implementation:

- **Never log a caught error object from either Google call.** Its string form
  embeds the request URI, and the URI carries `?key=`. Log `error.name`.
- Never put the key in a status message or an error screen.

## Ingest

Every boot, one signed `GET` of `.meta/db-status.json`:

```json
{"lastModified": 1756400000000}
```

Compare to the value stored in IndexedDB. Unchanged — the normal case — and
nothing further happens: no download, no WASM, no worker. Search runs off the
index already present. Cost is one round-trip.

Changed, or nothing stored yet, and a Worker:

1. Fetches `.meta/s3immich.db.gz` (~19 MB) with a signed URL.
2. Sniffs the first two bytes. `1f 8b` means gzip — pipe through
   `DecompressionStream("gzip")`. `SQLite format 3` means the object was stored
   with `Content-Encoding: gzip` and the browser already decompressed it. The
   phone's `uploadFileGzipped` sets no `Content-Encoding`, so the first case is
   expected; sniffing costs nothing and removes the assumption.
3. Hands the ~54 MB buffer to sql.js and runs six queries — one per index
   record below, plus `store_entity` id `2002` for the API key.
4. Posts the distilled index back, writes it to IndexedDB, records
   `lastModified`, and terminates.

The Worker means the main thread never blocks. The grid stays interactive and
search keeps using the previous index until the new one lands. Progress goes to
the existing status bar as bytes downloaded.

Peak memory in the Worker is roughly 120 MB — compressed, decompressed, and
sql.js's own copy alive at once. It all dies with the Worker. This is fine on a
desktop and tight on an old phone browser; there is no streaming alternative,
because sql.js needs the whole file resident.

### Why sql.js

The alternative is a hand-written SQLite page reader, which would keep the
project dependency-free. It was rejected on risk, not size:
`remote_asset_entity` is `WITHOUT ROWID` and so is stored as an index b-tree
rather than a table b-tree, the 3 KB embedding blobs all spill into
overflow-page chains, and column order has to be recovered by parsing
`CREATE TABLE` SQL. A misparse fails silently and looks like missing data.

Two properties keep the dependency contained:

- It is **import-only**. It loads in a Worker, only when the snapshot changed,
  and is discarded immediately. Steady-state search never touches it.
- It does **not need FTS5**. The OCR text is read from `asset_fts_content` —
  the plain shadow table holding `c0`/`c1`/`c2` — rather than by issuing
  `MATCH`. Any stock sql.js build works. Phrase semantics are reproduced at
  query time instead (see *Query*).

It sits behind the index-store interface, so a hand-written reader could
replace it later without touching search or UI.

`dist/sql-wasm.js` and `dist/sql-wasm.wasm` (~710 KB together) are committed
alongside the existing `dist/`, so serving still needs no build step. The
README's *"No dependencies at runtime"* claim becomes false and must be
rewritten.

## Index shape

Five records, ~11.5 MB. Typed arrays survive structured clone intact, so this
is five IndexedDB rows rather than 117,466.

Sizes below are measured against a real snapshot, **after** joining to live
remote assets — every extraction query joins `remote_asset_entity` on
`deleted_at IS NULL`, exactly as the reference does, because much of each table
belongs to phone-local assets this app cannot render. The raw table counts are
substantially larger and are not what gets stored.

| Record | Contents | Measured |
|---|---|---|
| `keys` | `string[]` of asset keys from `remote_asset_entity` where `deleted_at IS NULL` — the table every posting list indexes into | 6,934 keys, ~200 KB |
| `labels` | `terms: string[]`, `postings: Uint32Array`, `offsets: Uint32Array` | 3,416 terms, 117,466 postings, ~470 KB |
| `ocr` | per-asset normalized token string, keyed by index into `keys` | 2,052 rows, 229 KB normalized |
| `geo` | `keys: Uint32Array`, `lat: Float64Array`, `lon: Float64Array` | 3,182 points, ~76 KB |
| `embeddings` | `labels: string[]`, `vectors: Float32Array` (3,416 × 768), `dims`, `model` | 10.5 MB |

**`asset_fts_content.c0` is not always an S3 key.** It holds whatever asset the
FTS row was written for, and 742 of 8,299 rows carry phone-local numeric IDs
like `1000000020`. The join is what filters them; without it, OCR search would
index rows nothing can ever match.

**Embeddings are restricted to labels that survive the join** — 3,416 of the
3,494 stored vectors. This is a small, deliberate divergence from the
reference, which scores all of them: the other 78 belong only to phone-local
assets, so suggesting one produces a chip that dead-ends at zero results. Every
live label has an embedding, so nothing is lost by dropping them.

Asset IDs in the metadata DB **are** S3 keys — `2009/05/18/VIDEO0013.mp4` — the
same strings the manifest is keyed on. Search returns a `Set<string>` and the
grid takes it directly. There is no ID mapping anywhere in this feature.

Everything except `embeddings` loads into memory at boot: about 1 MB, and
search needs it synchronously. `embeddings` loads lazily on the first
zero-result search, so a session that never misses never pays for it.

Filenames are **not** imported. The manifest already holds every key, and the
manifest is authoritative about what can actually be rendered.

### No OCR inverted index

FTS5 `MATCH "phrase"` requires token *adjacency*, which an inverted index
cannot answer without also storing positions. At 350 KB of OCR text in total, a
linear scan is the simpler and more faithful answer.

At import, each asset's OCR text (241 KB of raw text, across the 2,080 rows
that join to live assets) is normalized once — NFD, combining marks stripped,
lowercased, split on non-alphanumerics, rejoined with single spaces — which is
what `unicode61` with default `remove_diacritics` does. Twenty-eight rows
consist purely of punctuation (`{`, `|`, `((`, `#` and similar) and normalize to empty; these are
dropped, leaving 2,052 rows in the index. At query time the same normalization
runs on the query, and a document matches when `(' ' + docTokens + ' ').includes(' ' + queryTokens + ' ')`. That is exact
phrase semantics, including the property that `cat` does not match `cats`.

## Query

Fires on **Enter**, not per keystroke — matching the reference's `onSubmitted`,
and keeping one Nominatim request per deliberate search, comfortably inside
their 1 req/s policy. The `×` button clears back to the full library.

Order and concurrency follow `SearchHandler._search`:

1. Start the Nominatim lookup and the translation concurrently. Both are capped
   at 3 s and neither can block what the local index already knows.
2. Run the local passes, synchronously, in memory:

   - **Labels.** `(' ' + term + ' ').includes(' ' + q + ' ')` over 3,416 terms.
     This is `' ' || LOWER(label) || ' ' LIKE '% q %'` verbatim: a whole-word
     match, so `train` does not match `strainer`.
   - **Labels, translated.** The same test against the da→en translation of the
     query, skipped when the translation is empty or equals the query. This is
     what makes `tog` find `train`, and it is deterministic — either the
     translated term appears in a label or it does not.
   - **OCR.** Phrase-adjacency scan, above. No translated pass: labels come
     from a small curated vocabulary, OCR text is whatever language was
     photographed, and translating a query to match arbitrary sign and receipt
     text adds noise rather than recall.
   - **Filenames.** Case-insensitive substring over the manifest.

3. Merge the place results when they arrive, or drop them on timeout.
4. Intersect everything with the manifest. This is what removes trashed rows
   and anything the bucket no longer holds.
5. Call the existing `render()` with the filtered items. The grid re-sections,
   the rail re-derives its years from what is left, and the lightbox steps
   through matches only.

**No result cap.** The reference has a comment about a "train" search where a
genuine match ranked past a fixed 100-item cutoff and simply vanished, with no
"load more" to reach it. This grid has no such affordance either. Filter
before you cap, and here there is nothing to cap.

## Place search

Same request `nominatim.dart` makes, minus the forbidden header:

```
GET https://nominatim.openstreetmap.org/search
    ?q=<query>&format=json&limit=5
    &polygon_geojson=1&namedetails=1&polygon_threshold=0.01
```

Queries shorter than 3 characters are not sent at all — Nominatim matches word
prefixes, so `cat` resolves to Catalunya and every photo geotagged in Barcelona
would surface for it.

A candidate is accepted only when the query names it **exactly**,
case-insensitively, against `name`, `namedetails.name:en` or
`namedetails.name:da`. Prefix matches are rejected for the same reason.

Accepted, the bounding box pre-filters `geo` and the polygon decides. The bbox
alone is not the answer: for territory crossing the antimeridian — Russia, Fiji
— Nominatim reports the longitude range as the full −180..180, which turns
"Russia" into "any longitude, latitude 41–82" and sweeps in most of populated
Canada. Ray-cast point-in-polygon against the actual rings, treating rings
after the first as holes and testing each member of a `MultiPolygon`
separately, does not have that failure mode. With no polygon geometry — a
point-like POI — the bbox stands alone.

Results are cached for 10 minutes, keyed on the raw query.

## Suggestions

Advisory only, and shown **only when the search returned nothing** — the
reference renders them inside `_SearchNoResults`, never alongside matches.
They are never blended into results. The user picks one, which re-searches
through the deterministic path above.

Each suggestion is a `(display, query)` pair. Place suggestions disambiguate in
`display` — `Guggenheim Museum (United States)` — while `query` stays the bare
name Nominatim itself will exact-match, so tapping a chip deterministically
finds that place. Label suggestions use the same string for both.

**Place suggestions** re-query Nominatim with `addressdetails=1` and
`accept-language=en` for a country name — both as **query parameters**, not
headers; the no-custom-headers rule above still holds — then drop any candidate whose name
equals what the user already typed — the deterministic path considered it
already, and offering it would resubmit an identical string.

**Semantic suggestions** embed the query through Gemini
(`gemini-embedding-001`, `outputDimensionality: 768`) and cosine-score it
against the imported label vectors, skipping rows whose `model` differs. Two
independent passes run — one on the raw
query, one on its translation — and **the pass with the closer top neighbour
wins outright**; the loser is discarded entirely, not merged. A Danish word has
no relationship to an English embedding space until translated, so a
same-threshold hit found only by the untranslated pass is lexical coincidence:
the reference records Danish `telt` ranking `elk` and `telephone` above `tent`.
Threshold 0.5, at most 5 results.

Only rows whose `model` matches are scored, and a row whose vector length
disagrees with the query's is skipped rather than allowed to abort the whole
suggestion pass.

The two lists merge place-first, deduplicated case-insensitively on `query`.

## Caching and timeouts

| Thing | Behaviour |
|---|---|
| Translation | 10 min, keyed on lowercased query; 3 s timeout |
| Query embedding | 10 min, keyed on lowercased query |
| Nominatim | 10 min, keyed on raw query; 3 s cap on the whole place pass |

All three are in-memory and per-session. Repeat searches and typo corrections
are common enough that this matters, and none of it is worth persisting.

Translation is hardcoded `source=da`, not auto-detected. Auto-detect is
unreliable on short context-free words — `kat` comes back `at`, `bil` comes
back `was`. The cost is occasionally mistranslating an already-English query as
Danish, which rarely coincides with a real label and is covered anyway by the
untranslated pass that always runs.

## Architecture

Eight modules under `src/search/`. The top level stays flat; eight more
`search*.ts` files beside `grid`/`rail`/`lightbox` would drown them.

| Module | Job | Pure? |
|---|---|---|
| `tokenize.ts` | `unicode61`-equivalent normalization | yes |
| `nominatim.ts` | Request shaping, exact-name match, polygon containment | geometry is pure |
| `local.ts` | Label, OCR and filename matching over an in-memory index | yes |
| `suggest.ts` | Cosine scoring, two-pass selection, list merging | yes |
| `google.ts` | Translate and embed. Null on any failure. Caches. | no |
| `import.ts` | Extraction SQL and index building, run under sql.js | no |
| `store.ts` | New IndexedDB stores, snapshot status, lazy embeddings | no |
| `search.ts` | Orchestration: concurrency, timeouts, merge, manifest intersect | no |

Dependencies flow one way: `search` → everything else in the directory;
`local` → `tokenize`; `suggest` → nothing; `import` → `tokenize`. Nothing in
`src/search/` touches the DOM. The UI lives in `main.ts` beside the existing
screen wiring.

`db.ts` goes from `VERSION` 1 to 2 to add the stores. The existing `creds`,
`manifest` and `meta` stores are untouched, and `nuke()` already drops the
whole database, so "forget credentials" needs no change.

## Failure handling

| Failure | Behaviour |
|---|---|
| No `.meta/db-status.json` (404) | Hide the search box; one-line note that the bucket has no metadata snapshot |
| Snapshot download or parse fails | Keep the existing index; status bar says the refresh failed; search still works |
| No index yet and download fails | Search box disabled with the reason; the gallery is unaffected |
| Translation fails or times out | Search proceeds without the translated pass |
| Nominatim fails or times out | Search proceeds without place results |
| Gemini fails | No semantic suggestions; place suggestions still shown |

The last three are silent, matching the reference's null-on-failure contract. A
blocked Gemini host degrades to "no chips", not to a broken search.

## Testing

`bun test`, covering the pure modules the way `sigv4`, `justify` and `keys` are
covered today.

| Test | Covers |
|---|---|
| `tokenize.test.ts` | Diacritic stripping, punctuation splitting, case, empty input |
| `local.test.ts` | Whole-word labels (`train` vs `strainer`), OCR phrase adjacency, `cat` vs `cats`, filename substring |
| `nominatim.test.ts` | `matchesExactName` across name/en/da, point-in-ring, holes, `MultiPolygon`, the antimeridian case |
| `suggest.test.ts` | Cosine, two-pass winner selection, threshold, limit, mismatched vector length |
| `import.test.ts` | The extraction SQL, run by sql.js under Bun against a fixture DB |

The fixture DB is a ~20-row SQLite file carved from a real snapshot by a script
in `tools/`, committed under `test/fixtures/`. It must contain at least one
`WITHOUT ROWID` row, one overflowing embedding blob, and one OCR row with
diacritics and punctuation.

The Worker plumbing, the search box, the chips and the live network calls are
verified by hand. There is no browser automation, as before.

## Documentation

`README.md` needs three changes:

- The dependency claim. `sql.js` is a runtime dependency, even if only during
  import.
- A search section: what is searchable, that it needs `.meta/`, and that the
  Google key is optional and what is lost without it.
- A note that the Google key already lives in the bucket inside the snapshot,
  and that a referrer-restricted second key is the safer option.

## Later

- **Thumbnail dimensions from the snapshot.** `remote_asset_entity` carries
  `width` and `height`. A `SqliteProvider` reading them would remove
  first-browse reflow entirely — the viewer design's own deferred item, and now
  a few lines, since the snapshot is already being parsed.
- **Faces and people.** `asset_face_entity` and `person_entity` are in the
  snapshot. Only 61 face rows today, so there is nothing to show yet.
- **A hand-written SQLite reader,** replacing sql.js behind the same interface,
  if the WASM dependency stops being worth it.
