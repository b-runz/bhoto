# s3-web-view

A photo viewer for an S3 bucket. Runs entirely in the browser — it signs its
own S3 requests, lists the bucket itself, and caches what it learns in
IndexedDB. There is no server.

Design notes: [`docs/superpowers/specs/2026-08-31-s3-photo-viewer-design.md`](docs/superpowers/specs/2026-08-31-s3-photo-viewer-design.md)

## Running it

```sh
bun install
bun run build
bun run serve       # http://localhost:8080
```

Then enter endpoint, region, bucket and a **read-only, bucket-scoped** API
key. Credentials are stored unencrypted in IndexedDB, so scope the key.

Serve over `http://localhost` or https — `crypto.subtle` does not exist on a
`file://` origin, and everything here depends on it.

## Bucket layout

```
2022/08/29/IMG_1234.jpg          originals
2022/08/29/VID_0001.mp4
.thumbs/2022/08/29/IMG_1234.jpg  thumbnails, mirroring the key exactly
.thumbs/2022/08/29/VID_0001.mp4  ...including a video's, which is a JPEG
```

Dates come from the path, never EXIF. Anything not matching
`YYYY/MM/DD/<name>.(jpg|jpeg|mp4)` is ignored.

Everything under `.thumbs/` is a JPEG whatever its extension says, so every
thumbnail is signed with `response-content-type=image/jpeg` and rendered in
an `<img>`. The extension is read in exactly one place: choosing `<img>` or
`<video>` in the lightbox.

## Search

Search matches filenames, OCR text, ML labels and place names. It reads a
metadata snapshot the phone app pushes to the bucket:

```
.meta/s3immich.db.gz     the metadata database
.meta/db-status.json     {"lastModified": <epoch ms>}
```

Without those, the search box hides itself and the gallery works as before.
The status file is checked on every load; the 19 MB snapshot is downloaded
only when it has changed, imported in a Worker, and distilled into about
11.5 MB of IndexedDB. Searching afterwards is local and synchronous.

Search fires on Enter. Place names go to Nominatim, which decides membership
by the place's actual polygon rather than its bounding box — so "Russia"
doesn't return half of Canada.

A **Google API key** is optional. With one, label search also works in Danish
(queries are translated before matching) and a search that finds nothing
offers "did you mean" suggestions. Without one, everything else still works.

Two things worth knowing about that key. It is **already in your bucket**: the
phone app stores it inside the snapshot, so anyone who can read the bucket can
read the key. And a key used from a browser can be restricted by HTTP referrer
to this origin, which a key used by the phone app cannot — so prefer minting a
second, restricted key and entering it on the setup screen rather than letting
the app fall back to the phone's.

## Bucket prerequisites

Listing is a `fetch`, so the bucket needs a CORS rule allowing GET from the
app's origin. Images and video don't — a plain `src` isn't a CORS request.
The app renders the exact rule to paste if listing fails.

## Development

```sh
bun run dev         # rebuild on change
bun run check       # tsc --noEmit — bun strips types without checking them
bun test
```

`dist/` is committed so the app can be served from any static host without a
build step.

Tests cover the pure modules — `sigv4`, `justify`, key parsing, and everything
under `src/search/` except the Worker, the IndexedDB glue and the live network
calls. `test/fixtures/search.db` is a ~20-row snapshot carved out by
`tools/make_search_fixture.py`, which whitelists `store_entity` down to just
the (placeholder) Google API key row and strips every other row, since one of
them holds the live bucket credential in the real snapshot; the import tests
run sql.js against it under Bun.

The signer is checked against `tools/gen_sigv4_fixtures.py`, an independent
implementation of the AWS spec that shares no code with it; regenerate the
fixtures with:

```sh
python tools/gen_sigv4_fixtures.py
```

DOM modules are verified by hand. There is no browser automation.

## Dependencies

One at runtime, and only while importing: `sql.js` (vendored into `dist/` as
`sql-wasm.js` and `sql-wasm.wasm`, ~710 KB) reads the metadata snapshot. It
loads in a Worker, only when the snapshot has changed, and is discarded
immediately — steady-state search never touches it. Everything else is
hand-written.

`typescript` is the only devDependency that isn't `sql.js`, and it exists
purely so `tsc --noEmit` can typecheck what Bun's transpiler ignores.
