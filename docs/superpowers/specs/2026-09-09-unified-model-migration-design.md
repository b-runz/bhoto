# Unified Asset Model Migration — Design

**Date:** 2026-09-09
**Status:** Approved for planning

The phone app (`immich-mobile-with-history`, branch `feat/unified-asset-model`)
replaces its whole database schema. The snapshot it pushes to
`.meta/s3immich.db.gz` is the database this viewer imports, so every table the
viewer's import reads disappears. This document covers the viewer's move to the
new schema, the viewer adopting the phone's new search semantics, and the one
change on the phone side the viewer depends on: the push has to publish the
status file again.

## Scope

**In:** the phone's push writes `.meta/db-status.json`; the viewer imports
`gallery_asset`, `gallery_label`, `label_embedding` and `store_entity`; a
single inverted index over name, labels, OCR and camera text; token-AND
matching that reproduces a bare FTS5 `MATCH`; a synthetic test fixture at the
new schema; README updates.

**Out:** thumbnail dimensions from the row, faces, people, albums, a snapshot
driven grid. The grid still lists the bucket.

**Kept as-is:** Danish translation of the query, place search, "did you mean"
suggestions, the Worker import path, the IndexedDB layout, the Google key
resolution order.

## Reference

Behaviour is defined by the phone branch. Where this document says "as the
phone does", the observable result must match, not the code.

| Concern | Source of truth on the phone branch |
|---|---|
| Schema | `lib/infrastructure/db/gallery_schema.dart` |
| FTS5 table and triggers | `lib/infrastructure/db/gallery_fts.dart` |
| Query folding | `lib/infrastructure/db/text_folding.dart` (`foldForSearch`) |
| Search SQL and match expression | `lib/infrastructure/db/asset_queries.dart` (`search`, `byLocation`, `buildMatchExpression`) |
| Suggestions, place pass | `lib/infrastructure/local_server/handlers/search_handler.dart` |
| Sync and upload | `lib/services/gallery_sync.service.dart` |

## Part A — the phone publishes the status file

### Problem

The old sync service read and wrote `.meta/db-status.json`. The new one does
neither. Only the one-off migration script writes the file, once. The viewer
compares the file's `lastModified` with the value it stored to decide whether
to re-download the snapshot, so after migration it would import once and never
see a phone push again.

### Change

In `GallerySyncService.push()`, after `uploadFileGzipped` returns, put
`.meta/db-status.json` with content type `application/json` and body:

```json
{"lastModified": 1757400000000}
```

`lastModified` is the current time in epoch milliseconds. Nothing else is in
the body. The old file's `assetCount` fed a shrink guard that no longer exists;
the migration script writes the same single-field shape.

The write is part of push, not a separate step, so the ordering is: checkpoint,
upload database, write status, clear dirty. A status write that throws
propagates like an upload failure. The dirty flag stays set and the next flush
retries both writes. Re-uploading the database is idempotent.

Push must never write the status file when the gate refuses the upload.

### Tests

In `test/services/gallery_sync_push_test.dart`:

- A push after a unioned pull puts `.meta/db-status.json` once, after the
  database upload, with a JSON body whose `lastModified` is a number no earlier
  than the test started.
- A push refused by the gate puts nothing, status file included.

The stale doc comment on `S3Service.tryGetObject` that names the status file as
a phone-side caller is corrected.

## Part B — the viewer

### The snapshot after migration

One row per photo in `gallery_asset`, keyed by checksum. Columns the viewer
reads:

| Column | Meaning |
|---|---|
| `remote_key` | the S3 object key, `''` when the photo is only on the phone |
| `visibility` | `0` timeline, `1` hidden, `2` archive, `3` locked |
| `name_normalized` | filename, folded by `foldForSearch` |
| `label_text` | every label, folded, sorted by confidence, deduplicated, space-joined |
| `camera_text` | make and model, folded |
| `ocr_text` | raw recognizer output, **not** folded |
| `has_location`, `latitude`, `longitude` | GPS, inline |

Child tables: `gallery_label (checksum, label, …)` with the raw label per row,
and `label_embedding (label, embedding, model, …)` with the label lowercased.
`store_entity` is still in the phone's Drift file and rides along in every
push, so row 2002 still carries the Google key. The migration script builds a
fresh file from the asset DDL only, so the table is absent from the bucket
until the phone's first push.

There is no `deleted_at`. A deleted photo has no row.

### Renderable rows

A row is indexed when `remote_key <> ''` and `visibility = 0`. This is the
phone's own filter for both `search` and `byLocation`. Archived, hidden and
locked photos are not searchable even if their objects are in the bucket. The
manifest intersection at the end of every search stays: it is what removes
keys the bucket no longer holds.

### Extraction

Six statements, run under sql.js in the Worker as today:

```sql
-- keys
SELECT remote_key FROM gallery_asset
 WHERE remote_key <> '' AND visibility = 0 ORDER BY remote_key;

-- text
SELECT remote_key, name_normalized, label_text, camera_text, ocr_text
  FROM gallery_asset WHERE remote_key <> '' AND visibility = 0;

-- geo
SELECT remote_key, latitude, longitude FROM gallery_asset
 WHERE remote_key <> '' AND visibility = 0 AND has_location = 1;

-- live labels, for restricting embeddings
SELECT DISTINCT LOWER(l.label) FROM gallery_label l
  JOIN gallery_asset a ON a.checksum = l.checksum
 WHERE a.remote_key <> '' AND a.visibility = 0;

-- embeddings
SELECT label, embedding FROM label_embedding WHERE model = 'gemini-embedding-001';

-- api key, only if the table exists
SELECT string_value FROM store_entity WHERE id = 2002;
```

Before the last statement the import checks `sqlite_master` for
`store_entity`. Absent table means a null key, not a failed import.

Latitude and longitude are `REAL NOT NULL` with a `0.0` default, so the
`has_location` predicate is what excludes unlocated rows, not a null test.

### Index shape

One inverted index replaces the separate label and OCR structures:

| Field | Type | Contents |
|---|---|---|
| `format` | `number` | `2`. See *Format versioning*. |
| `keys` | `string[]` | renderable `remote_key`s, sorted |
| `terms` | `string[]` | distinct tokens, sorted |
| `offsets` | `Uint32Array` | `terms.length + 1`; list `t` spans `[offsets[t], offsets[t+1])` |
| `postings` | `Uint32Array` | indices into `keys`, grouped by term, ascending within a term |
| `geoKeys`, `geoLat`, `geoLon` | as today | rows with `has_location = 1` |

Per row, the token set is the union of `normalize(name_normalized)`,
`normalize(label_text)`, `normalize(camera_text)` and `normalize(ocr_text)`
split on spaces, deduplicated. A row appears once per distinct token it
carries, whichever column it came from. Positions and column identity are not
stored: a bare FTS5 match on a multi-token query needs neither.

`embeddings` keeps its shape. Labels are restricted to the live-label set
above, compared lowercase to lowercase, as today, so a suggested chip cannot
dead-end at zero results.

### Two folding functions, deliberately

The phone indexes column text through FTS5's `unicode61` tokenizer and folds
the *query* with `foldForSearch`. The two agree on ASCII and on decomposable
accents, and disagree on letters with no decomposition: `foldForSearch` maps
`ø`→`o`, `æ`→`ae`, `ß`→`ss`, `ð`→`d`, `ł`→`l` and so on; `unicode61` leaves
them. Parity with the phone therefore needs both:

- **Index side:** the existing `normalize()` in `tokenize.ts`, which emulates
  `unicode61` with `remove_diacritics 1`. Applied to every column, including
  the ones the phone already folded. `unicode61` on folded ASCII is the
  identity split, so this is exact.
- **Query side:** a new `fold()` in `tokenize.ts`, a verbatim port of
  `foldForSearch`: the same character table, `\p{L}` and `\p{Nd}` as the
  token classes, runs of anything else become one space, then trim. The table
  is copied, not approximated with NFD, because the whole point is to match
  the phone character for character.

Consequence, inherited from the phone: OCR text containing `Ærø` is indexed as
`ærø` and a query `Ærø` folds to `aero`, so it does not match. A label or
filename containing `Ærø` was folded at write time and does match. The viewer
reproduces this rather than fixing it.

### Matching

```
tokens = fold(query).split(' ')           // empty -> no results
for each token: binary-search terms; absent -> no results
result = intersection of the tokens' posting lists, mapped through keys
```

This is `gallery_fts MATCH '<folded query>'`: adjacent bare tokens are an
implicit AND, each token matches a whole token in any column, and nothing
matches by prefix or substring. `cat` does not match `cats`; `IMG_48` does not
match `IMG_4821`; `img 4821` does. Lowercase `and`, `or`, `not` are ordinary
tokens, as they are to FTS5.

Filename matching moves into the index through `name_normalized`. The manifest
substring pass in `local.ts` is removed.

### Orchestration

`search.ts` keeps its concurrency shape. Per search:

1. Start the Nominatim place pass and the translation, both capped at 3 s.
2. Run the token match on the raw query.
3. When the translation arrives, and it is non-empty and differs from the
   lowercased query, run the token match on it too and union the result.
   Translation is a viewer feature the phone no longer has. It stays because
   it works, and because the same-match-either-way rule makes it
   deterministic.
4. Union the place results when they arrive, or drop them on timeout.
5. Intersect with the manifest.

No result cap. The phone caps at 200; this grid has no "load more", so a cap
would silently hide matches. A deliberate divergence, as in the original search
design.

The place pass is unchanged: exact-name Nominatim candidate, bounding box over
`geo`, polygon containment.

### Suggestions

Unchanged in behaviour. Semantic suggestions still run two passes, raw and
translated, and `pickPass` still chooses the pass with the closer top
neighbour. Place suggestions are unchanged.

### Format versioning

The stored index gains `format: 2`. `loadIndex()` returns null when the stored
record lacks it or carries another value. The boot sequence already treats a
null local index together with a remote `lastModified` as "import now", so a
viewer upgraded before or after the bucket is migrated re-imports on its next
load without a schema check of its own.

A viewer at this version against a bucket still at the old schema fails the
import: `gallery_asset` does not exist. The status bar reports that the index
could not be built and the gallery works without search. Migrating the bucket
first is a precondition here exactly as it is for the phone.

### Storage

`db.ts` is unchanged. The four `search` records keep their names. `saveImport`
writes the same four keys in one transaction.

### Fixture

`tools/make_search_fixture.py` stops carving a real snapshot and builds
`test/fixtures/search.db` from scratch. This removes the secret-redaction
machinery: nothing real goes in, so nothing real can leak.

The DDL is copied from the phone's Drift definitions, column order included,
with `month_day` last. `gallery_fts` and its three triggers are created too, so
the import tests prove sql.js opens a database containing an FTS5 virtual table
and triggers. Rows:

| Row | Purpose |
|---|---|
| 6 renderable assets | names with underscores and digits, labels including a multi-word one, OCR with diacritics and punctuation, camera text on some, GPS on some |
| 1 asset with `remote_key = ''` | excluded by the renderable filter |
| 1 asset with `visibility = 2` | excluded by the renderable filter |
| 1 asset with `ocr_text` of pure punctuation | normalizes to nothing, contributes no tokens |
| 1 asset with OCR containing `Ærø` | documents the folding asymmetry |
| `gallery_label` rows for the labels above, plus one on the local-only asset | drives the live-label restriction |
| `label_embedding`: one per live label, one dead-end label, one wrong-model row | 3072-byte blobs, one of which overflows a page |
| `store_entity` row 2002 with the placeholder key | the key read |

The builder runs `VACUUM` and asserts the file contains the placeholder key
and no other `AIza`-prefixed string, kept from the old tool as a cheap tripwire
against a future edit that pastes a real key in.

### Tests

`bun test`, pure modules only, as today.

| Test | Covers |
|---|---|
| `tokenize.test.ts` | `normalize` as before; `fold` against the Dart table: `Ærø`→`aero`, `ß`→`ss`, `Łódź`→`lodz`, `İ`→`i`, `IMG_4821`→`img 4821`, CJK and Cyrillic preserved, `²` dropped |
| `local.test.ts` | token AND across columns, single token in OCR, single token in name, `cat` vs `cats`, no prefix, unknown token empties the result, empty query, folded query equals stored token |
| `import.test.ts` | against the fixture: keys exclude local-only and archived rows; every column contributes tokens; punctuation-only OCR contributes none; `Ærø` indexed as `ærø`; geo excludes unlocated rows; embeddings drop the dead-end and wrong-model rows and are 768 wide; key read returns the placeholder; key read returns null after the table is dropped on a copy |
| `search.test.ts` | orchestration with injected deps: raw and translated matches union, translation timeout, place timeout, manifest intersection |
| `suggest.test.ts` | unchanged |
| `google.test.ts` | unchanged |

Dropping `store_entity` in the import test needs one more method on the
`SqlDatabase` interface in `sqljs.ts`: `run(sql)`, which sql.js provides.

The Worker, the search box and the live network calls are verified by hand,
as before.

### Documentation

`README.md`:

- Search section: what is searchable now includes camera make and model;
  matching is by whole token, every token must match, no prefix or substring;
  filenames are matched by their tokens, so `4821` finds `IMG_4821.jpg` and
  `IMG_48` does not; Danish translation still applies to the whole query.
- The status file is written by the phone after every push, and by the
  migration script.
- The fixture is synthetic; the redaction story goes.
- Bucket migration to the new schema is a precondition for search.

## Cross-repo sequencing

1. Phone branch: push writes the status file. Land on `feat/unified-asset-model`.
2. Viewer branch: this migration. Land on `feat/unified-asset-model` here.
3. Run the migration script against the bucket.
4. Deploy the viewer. Until step 3 runs, the new viewer shows the gallery with
   search unavailable, and the old viewer keeps working against the old
   snapshot.
