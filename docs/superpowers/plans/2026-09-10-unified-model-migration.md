# Unified Asset Model Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the viewer's search import onto the phone's new `gallery_asset` schema with the phone's token-AND matching, and make the phone's push publish the status file the viewer refreshes on.

**Architecture:** Task 1 is a bounded change in the phone repo's worktree. Tasks 2–8 rebuild the viewer's `src/search/` import and matching around one inverted index, keeping the Worker, IndexedDB layout, translation, place search and suggestions as they are. A synthetic fixture replaces the carved one.

**Tech Stack:** Dart/Drift/mocktail on the phone. TypeScript, Bun, sql.js and Python 3 `sqlite3` for the fixture on the viewer.

**Spec:** `docs/superpowers/specs/2026-09-09-unified-model-migration-design.md`. The plan argues from the spec; read both. Where this plan and the spec disagree, the spec wins.

**Style of this plan:** By the user's instruction, tasks state *what* must be true and how it is verified. The implementation is the implementer's call, within the interfaces given. Follow the existing code's conventions in each repo: doc comments that say *why*, no new dependencies, and the viewer's rule that nothing under `src/search/` touches the DOM.

## Global Constraints

- Viewer worktree: `C:\Users\bru\spare-source\s3-web-view\.claude\worktrees\unified-asset-model`, branch `feat/unified-asset-model`.
- Phone worktree: `C:\Users\bru\spare-source\immich-mobile-with-history\.claude\worktrees\unified-asset-model`, branch `feat/unified-asset-model`. Task 1 runs there and nowhere else. It has uncommitted edits in four files unrelated to this work; do not touch or commit them.
- Commit identity for both repos: `b-runz <bjarke.runz@outlook.dk>`. Pass it with `git -c user.name=b-runz -c user.email=bjarke.runz@outlook.dk commit …` rather than changing repo config.
- Viewer: no new runtime or dev dependencies. `sql.js` stays import-only inside the Worker.
- Viewer: `dist/` is committed build output. Any task that changes `src/`, `index.html` or `css/` must finish with `bun run build` and commit `dist/` in the same commit.
- Viewer verification commands: `bun test`, `bun run check`, `bun run build`.
- Phone verification command, run from the phone worktree: `flutter test test/services/gallery_sync_push_test.dart`.
- Never log or print a Google API key, a presigned URL, or a caught error object from a Google call. The fixture's only key is the placeholder `AIzaSyFIXTURE-not-a-real-key-000000000000`.
- Status file contract, both sides: key `.meta/db-status.json`, body `{"lastModified": <epoch ms as a JSON number>}`, content type `application/json`.

---

### Task 1: Phone push publishes the status file

**Repo:** phone worktree only.

**Files:**
- Modify: `lib/services/gallery_sync.service.dart` (`push()`)
- Modify: `lib/services/s3/s3_service.dart` (doc comment on `tryGetObject`, around line 194)
- Test: `test/services/gallery_sync_push_test.dart`

**Interfaces:**
- Consumes: `S3Service.putObject(String s3Key, List<int> data, {String contentType})`, already present. `S3Service.uploadFileGzipped(String s3Key, String filePath)`, already called by `push()`.
- Produces: after a successful `push()`, the object `.meta/db-status.json` exists in the bucket with the body in Global Constraints.

**Required behaviour:**
- `push()` order becomes: gate check, WAL checkpoint, `uploadFileGzipped`, `putObject` of the status file, clear the dirty flag.
- A refused push (gate says no) writes nothing at all.
- If the status write throws, the exception propagates and the dirty flag stays set, exactly as an upload failure behaves today.
- `lastModified` is the current wall-clock time in epoch milliseconds.
- The `tryGetObject` doc comment no longer claims the status file has a phone-side reader. Say instead that the viewer reads it and the phone only writes it.

**Tests to add** (mocktail, same harness the file already uses; stub `putObject` with a fallback the way `uploadFileGzipped` is stubbed in `setUp`):
- After a unioned pull, `push()` calls `putObject('.meta/db-status.json', …, contentType: 'application/json')` exactly once, and the captured body decodes to a map whose `lastModified` is an `int` no earlier than a timestamp taken before the call.
- The status put happens after the database upload. Use `verifyInOrder`.
- After a failed pull, `push()` never calls `putObject`.
- When `putObject` throws, `push()` rethrows and a following `flush()` with a succeeding stub uploads again. Model it on the existing dirty-flag-survives-failure test in the same file.

- [ ] **Step 1:** Write the four tests. Run the file. Expected: the new tests fail, existing ones pass.
- [ ] **Step 2:** Implement the status write in `push()` and fix the doc comment.
- [ ] **Step 3:** Run `flutter test test/services/gallery_sync_push_test.dart`. Expected: all pass. Also run `flutter test test/services/gallery_sync_pull_test.dart test/services/gallery_sync_absence_test.dart` to confirm nothing else in the service moved.
- [ ] **Step 4:** Commit only the three files above, message `feat: publish db-status.json after every push`.

---

### Task 2: Query folding that matches the phone

**Repo:** viewer.

**Files:**
- Modify: `src/search/tokenize.ts`
- Test: `test/search/tokenize.test.ts`

**Interfaces:**
- Produces: `export function fold(text: string): string` — a verbatim port of `foldForSearch` in the phone's `lib/infrastructure/db/text_folding.dart`. The existing `normalize()` is unchanged and stays exported.

**Required behaviour:**
- Same character table as the Dart file, copied entry for entry. Do not replace it with NFD decomposition: the spec's *Two folding functions* section explains why the two must differ.
- Token classes are `\p{L}` and `\p{Nd}`. Runs of anything else become one space. Result is lowercased and trimmed.
- Module doc comment explains the two functions' roles: `normalize` emulates FTS5 `unicode61` for the index side, `fold` ports the phone's query folding, and both are needed for parity.

**Tests to add:** `Ærø`→`aero`, `Straße`→`strasse`, `Łódź`→`lodz`, `İstanbul`→`istanbul`, `IMG_4821.jpg`→`img 4821 jpg`, `Café-Nord!`→`cafe nord`, Cyrillic and CJK preserved, `m²`→`m`, `  x  `→`x`, empty string→empty string. Add one test that shows where `fold` and `normalize` differ (`Ærø`).

- [ ] **Step 1:** Write the tests. Run `bun test test/search/tokenize.test.ts`. Expected: failures on `fold`.
- [ ] **Step 2:** Implement `fold`.
- [ ] **Step 3:** `bun test test/search/tokenize.test.ts` passes. `bun run check` passes.
- [ ] **Step 4:** Commit `feat: port the phone's foldForSearch for query-side folding`.

---

### Task 3: Synthetic fixture at the new schema

**Repo:** viewer.

**Files:**
- Rewrite: `tools/make_search_fixture.py`
- Regenerate: `test/fixtures/search.db`
- Modify: `src/search/sqljs.ts` (add `run(sql: string): void` to `SqlDatabase`)
- Test: `test/search/sqljs.test.ts` (extend)

**Interfaces:**
- Produces: a fixture whose contents later tasks assert against. Fix the exact rows in the script as named constants so Task 5's tests can reference them by key and token. Record the intended rows in the script's module docstring.

**Required behaviour of the script:**
- Usage: `python tools/make_search_fixture.py test/fixtures/search.db`. No source database argument. Deletes and recreates the output.
- Creates every table the phone's `lib/infrastructure/db/gallery_schema.dart` declares, with every column in declaration order and `month_day` last, `NOT NULL` with the same defaults. Drift types map as `TextColumn`→`TEXT`, `IntColumn`/`BoolColumn`→`INTEGER`, `RealColumn`→`REAL`, `BlobColumn`→`BLOB`. Primary keys and foreign keys as declared.
- Creates `gallery_fts` and its three triggers exactly as `lib/infrastructure/db/gallery_fts.dart` does, before inserting any rows, so the triggers populate it. If the local Python's SQLite lacks FTS5, the script must say so and exit non-zero rather than silently skip.
- Creates `store_entity (id INTEGER PRIMARY KEY, string_value TEXT, int_value INTEGER)` with one row, id 2002, whose `string_value` is `{"apiKey":"AIzaSyFIXTURE-not-a-real-key-000000000000"}`.
- Inserts the rows in the spec's *Fixture* table. Minimum content, all under `2024/…` keys so they parse as bucket keys: six renderable rows covering a multi-word label (`passenger train`), a label shared by two rows, a filename with underscore and digits, OCR with diacritics and punctuation, a row with camera make and model, at least three rows with `has_location = 1` and distinct coordinates, and one unlocated row with the default `0.0` coordinates; one row with `remote_key = ''`; one row with `visibility = 2`; one renderable row whose `ocr_text` is only punctuation; one renderable row whose `ocr_text` contains `Ærø`. `name_normalized`, `label_text` and `camera_text` must be written already folded, the way the phone writes them; `ocr_text` raw.
- `gallery_label` rows for each label on each row that carries it, plus one label that exists only on the local-only row.
- `label_embedding`: one row per live label with a 3072-byte blob of deterministic non-zero float32 values, model `gemini-embedding-001`; one row for the local-only label; one row with model `other-model`. Make one live label's vector distinct enough that a cosine test can pick it.
- `VACUUM`, then the tripwire: the file bytes contain the placeholder and no other `AIza`-prefixed string.

**`sqljs.ts`:** add `run(sql: string): void` to the interface. sql.js provides it. Extend the existing `sqljs.test.ts` with one test that opens the fixture, runs `SELECT COUNT(*) FROM gallery_asset`, and gets the row count the script documents — this is the proof sql.js opens a database containing an FTS5 virtual table and triggers.

- [ ] **Step 1:** Write the script. Run it. Expected: file written, tripwire message printed.
- [ ] **Step 2:** Add the `run` method and the count test. Run `bun test test/search/sqljs.test.ts`. Expected: pass.
- [ ] **Step 3:** Run the full `bun test`. Expected: `import.test.ts` now fails because it queries tables that no longer exist. That is expected and is fixed in Task 5. Everything else passes.
- [ ] **Step 4:** Commit the script, the fixture, `sqljs.ts` and its test: `test: build the search fixture from the unified schema instead of carving a snapshot`.

---

### Task 4: One inverted index and token-AND matching

**Repo:** viewer.

**Files:**
- Modify: `src/search/local.ts`
- Test: `test/search/local.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const INDEX_FORMAT = 2;
  export interface SearchIndex {
    format: number;          // INDEX_FORMAT
    keys: string[];
    terms: string[];         // sorted
    offsets: Uint32Array;    // terms.length + 1
    postings: Uint32Array;   // indices into keys, grouped by term, ascending within a term
    geoKeys: Uint32Array;
    geoLat: Float64Array;
    geoLon: Float64Array;
  }
  export function matchTokens(index: SearchIndex, query: string): Set<string>;
  export function pointsInBox(...)   // unchanged
  export interface GeoPoint          // unchanged
  ```
- Removes: `matchLabels`, `matchOcr`, `matchNames`. Task 6 updates their callers.

**Required behaviour of `matchTokens`:**
- Folds the query with `fold` from Task 2, splits on single spaces. Empty → empty set.
- Each token is looked up in `terms` (binary search; `terms` is sorted). Any token absent → empty set.
- Result is the intersection of the tokens' posting lists, mapped through `keys`. Intersect the smallest list first.
- No prefix, no substring, no column awareness. Module doc comment says this reproduces a bare FTS5 `MATCH` with implicit AND and points at the spec.

**Tests to add** (build small indexes by hand in the test; a helper that turns `{key: "tokens …"}` into a `SearchIndex` keeps them readable): two-token query hits a row carrying both tokens in different "columns" (the index does not know columns, so this is just two tokens on one row); a row carrying only one of the two is excluded; `cat` does not match a row with `cats`; `img` does not match `img4821`; `img 4821` matches a row with both tokens; unknown token → empty; empty and whitespace query → empty; query with diacritics and punctuation folds before lookup (`Café-Nord` finds `cafe nord`); `pointsInBox` tests carried over unchanged.

- [ ] **Step 1:** Rewrite `local.test.ts` for the new API. Run it. Expected: type errors and failures.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `bun test test/search/local.test.ts` passes. `bun run check` will still fail in `import.ts` and `search.ts`; that is expected until Tasks 5 and 6.
- [ ] **Step 4:** Commit `feat: one inverted index with FTS5-style token matching`.

---

### Task 5: Import from the unified schema

**Repo:** viewer.

**Files:**
- Modify: `src/search/import.ts`
- Test: `test/search/import.test.ts`

**Interfaces:**
- Consumes: `SearchIndex`, `INDEX_FORMAT` from Task 4; `normalize` from `tokenize.ts`; `SqlDatabase` with `run` from Task 3; `EMBEDDING_MODEL`, `Embeddings` from `suggest.ts`.
- Produces: `export function buildIndex(db: SqlDatabase): ImportResult` with the same `ImportResult` shape as today (`index`, `embeddings`, `apiKey`).

**Required behaviour:** the spec's *Extraction* and *Index shape* sections, verbatim. In particular:
- Renderable rows are `remote_key <> '' AND visibility = 0`. `keys` sorted by `remote_key`.
- Per row, tokens are the union of `normalize()` over `name_normalized`, `label_text`, `camera_text` and `ocr_text`, deduplicated. Terms sorted; posting lists ascending; `offsets` has `terms.length + 1` entries.
- Geo from rows with `has_location = 1` only.
- Embeddings for `EMBEDDING_MODEL` only, restricted to labels present on renderable rows via `gallery_label` (lowercase compare), 768 wide, copied out of the blob rather than viewed.
- `apiKey` read from `store_entity` id 2002 only if `sqlite_master` lists that table; otherwise `null`. Never throw for a missing table.
- `index.format` is `INDEX_FORMAT`.
- The module doc comment replaces the old explanation of the `deleted_at` join with the new renderable filter and the two-folding-functions rule.

**Tests to add,** all against `test/fixtures/search.db` through sql.js as the current test does: keys are exactly the six renderable keys, sorted, excluding the local-only and archived rows; a filename token, a label token, a camera token and an OCR token each resolve to the expected keys; the multi-word label yields two separate terms; the punctuation-only OCR row contributes no terms beyond its other columns; `ærø` is a term and `aero` is not; `offsets` length and monotonicity; geo has exactly the located rows and not the `0.0/0.0` one; embeddings contain the live labels, not the local-only label, not the `other-model` row, `dims === 768`, `vectors.length === labels.length * 768`; `apiKey` equals the placeholder JSON; after `db.run("DROP TABLE store_entity")` on a fresh instance, `buildIndex` returns `apiKey === null` and everything else unchanged; `format === INDEX_FORMAT`.

- [ ] **Step 1:** Rewrite `import.test.ts`. Run it. Expected: failures.
- [ ] **Step 2:** Rewrite `buildIndex`.
- [ ] **Step 3:** `bun test test/search/import.test.ts` passes.
- [ ] **Step 4:** Commit `feat: import the search index from gallery_asset`.

---

### Task 6: Orchestration, storage format check, and UI wiring

**Repo:** viewer.

**Files:**
- Modify: `src/search/search.ts`
- Modify: `src/search/store.ts`
- Modify: `src/main.ts` (search wiring only)
- Test: `test/search/search.test.ts`
- Test: `test/search/store.test.ts` (new, pure helper only)

**Interfaces:**
- Consumes: `matchTokens`, `SearchIndex`, `INDEX_FORMAT` from Task 4.
- Produces: `SearchDeps` loses nothing the UI needs but `items` becomes used only for the manifest intersection. `runSearch` and `suggestFor` keep their signatures. `store.ts` exports `export function isCurrentIndex(value: unknown): value is SearchIndex` and `loadIndex()` returns `null` when the stored record fails it.

**Required behaviour:**
- `runSearch`: start place pass and translation first, as today; `matchTokens` on the raw query; when the translation resolves non-empty and different from the lowercased query, `matchTokens` on it too and union; union the place results; intersect with the manifest. No result cap. Remove the filename pass.
- `suggestFor`: unchanged behaviour. Only the import of removed functions changes.
- `isCurrentIndex`: true only for an object with `format === INDEX_FORMAT` and the typed-array fields present. `loadIndex` uses it, so a pre-migration record in IndexedDB reads as absent and the boot sequence in `main.ts` re-imports on the next changed or first-seen `lastModified`. Confirm by reading `main.ts` around the `remoteSnapshot`/`getSnapshot` comparison that a null local index with an unchanged remote `lastModified` still triggers an import; if it does not, make `main.ts` treat "index missing" as "import now" without changing how the status file is read.
- `main.ts`: no behaviour change beyond the above. Translation wiring stays.

**Tests:** rewrite `search.test.ts` around `matchTokens` semantics with injected deps: raw hit; translated hit unions with raw; translation that equals the query is not re-run; translation timeout leaves raw results; place timeout leaves text results; manifest intersection removes a key the index has and the manifest lacks; `suggestFor` tests carried over. New `store.test.ts` covers `isCurrentIndex` with a valid index, a legacy record with `labelTerms`, `null`, and a wrong `format`.

- [ ] **Step 1:** Write the tests. Run `bun test`. Expected: failures in the two files.
- [ ] **Step 2:** Implement. Run `bun test` and `bun run check`. Expected: everything passes, including the whole suite.
- [ ] **Step 3:** `bun run build`. Load `dist/` with `bun run serve` against the real bucket only if credentials are at hand; otherwise skip and say so in the commit body. This is the one hand-verified step the spec allows.
- [ ] **Step 4:** Commit source, tests and `dist/`: `feat: search by folded tokens over the unified index`.

---

### Task 7: README

**Repo:** viewer.

**Files:**
- Modify: `README.md`

**Required content changes,** per the spec's *Documentation* section:
- Search section: searchable fields now include camera make and model. Matching is whole-token, every token must match, no prefix or substring. Give the `4821` / `IMG_48` example. Danish translation still applies to the whole query. Place search and suggestions unchanged.
- The snapshot paragraph: the phone writes `.meta/db-status.json` after every push, and the migration script writes it once. Describe the body.
- Development section: the fixture is generated from the schema by `tools/make_search_fixture.py` with no source database; drop the redaction story; keep the sentence that the import tests run sql.js against it under Bun.
- A short note that the bucket must have been migrated to the unified schema for search to work, and what the viewer does if it has not (gallery works, search reports it cannot build its index).
- Remove every mention of `remote_asset_entity`, `asset_fts_content`, `store_entity` whitelisting and `deleted_at`.

- [ ] **Step 1:** Edit. Re-read the whole README once for stale claims.
- [ ] **Step 2:** Commit `docs: describe search over the unified asset model`.

---

### Task 8: Final verification

**Repo:** both.

- [ ] **Step 1:** Viewer: `bun test`, `bun run check`, `bun run build`, then `git status` must be clean (build output already committed in Task 6). If `dist/` differs, commit it as `build: refresh dist`.
- [ ] **Step 2:** Phone: `flutter test test/services/` from the phone worktree. All pass. `git status` shows only the four pre-existing modified files.
- [ ] **Step 3:** Viewer: `git log --oneline main..HEAD` lists the spec, the plan and Tasks 2–7 in order. Report the list.

---

## Self-review notes

- **Spec coverage:** Part A → Task 1. Renderable rows, extraction, index shape → Task 5. Two folding functions → Task 2 (`fold`) and Task 5 (`normalize` on the index side). Matching → Task 4. Orchestration, no cap, translation kept → Task 6. Suggestions unchanged → Task 6 carries tests over. Format versioning → Task 6. Storage unchanged → no task, by design. Fixture → Task 3. Tests → Tasks 2–6. Documentation → Task 7. Cross-repo sequencing → Task 8 verifies both sides; running the bucket migration itself is outside this plan.
- **Names used across tasks:** `fold` (2→4), `INDEX_FORMAT`, `SearchIndex`, `matchTokens`, `pointsInBox` (4→5, 6), `SqlDatabase.run` (3→5), `buildIndex`/`ImportResult` (5→6 via `store.ts`, unchanged), `isCurrentIndex` (6).
