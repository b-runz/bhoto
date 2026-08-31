# S3 Photo Viewer — Design

**Date:** 2026-08-31
**Status:** Approved for planning

A Google Photos–style viewer for photos kept in S3-compatible storage. It all runs in the browser. There is no server — the page signs its own S3 requests, lists the bucket itself, and caches what it learns.

## Scope

**In:** a reverse-chronological grid of thumbnails, a year rail to jump around, full-resolution view, inline video playback, and remembered credentials.

**Out:** upload, delete, edit, albums, sharing, search, face grouping, maps. The storage schema leaves room for labels, OCR text, lat/long and EXIF, but nothing shows them yet.

## Prerequisites

Three things have to be true of the bucket. Only the first can be fixed from the page itself.

1. **A read-only, bucket-scoped API key.** The secret is stored in plaintext in the browser, so keep what it can do small.
2. **A CORS rule allowing GET from the app's origin.** Listing is a `fetch`, so it needs one. Images and video don't — an `<img>` or `<video>` with a plain `src` isn't a CORS request — but without listing there's nothing to show.
3. **A populated `.thumbs/`,** mirroring the original keys exactly.

## Bucket layout

Originals are at `YYYY/MM/DD/<name>.<ext>`, where `ext` is `jpg`, `jpeg` or `mp4` (case-insensitive). Thumbnails sit at the same path under `.thumbs/`.

```
2022/08/29/IMG_1234.jpg
.thumbs/2022/08/29/IMG_1234.jpg
```

Anything not matching `^\d{4}/\d{2}/\d{2}/` is ignored, as is everything under `.thumbs/` when building the manifest, and any extension we don't recognise. Dates come from the path — never EXIF, never `LastModified`. The path is the only thing that determines order.

### Thumbnails are always images

A video's thumbnail is at `.thumbs/2022/08/29/VID_0001.mp4`, and the contents are a JPEG despite the name. So:

> **Everything under `.thumbs/` is a JPEG, whatever the extension says. The extension describes the original, not the thumbnail.**

The grid therefore has no extension logic at all — every tile is an `<img>`. The extension is read in exactly one place: picking `<img>` or `<video>` in the lightbox.

One wrinkle. S3 doesn't inspect files; it stores whatever `Content-Type` the uploader set and returns that string on every GET. Most upload tools guess from the extension, so a JPEG named `.mp4` probably comes back as `video/mp4` — and if nothing set one, the default is `binary/octet-stream`. Neither is `image/jpeg`.

In practice browsers sniff images and will render it anyway. But we can remove the doubt for free: presigned URLs accept a signed `response-content-type` parameter, so **every** thumbnail URL is signed with `response-content-type=image/jpeg`. No conditional, no reliance on sniffing, and it fixes any `.jpg` stored with a wrong type too. `sigv4.ts` gains an optional bag of extra query params for this.

**Check this first.** Before building on it, confirm two things against a real object: what `Content-Type` the thumbnails actually have, and whether Scaleway honours `response-*` overrides. `curl -sI "<presigned url>"` answers both. If overrides turn out unsupported, drop the parameter and rely on sniffing.

Full-resolution files need no override — a `.mp4` original really is an MP4.

## Architecture

ES modules under `src/`, bundled by Bun into one `dist/app.js`.

| Module | Job |
|---|---|
| `types.ts` | Shared types. No logic. |
| `sigv4.ts` | SigV4 presigning. No DOM, no storage. |
| `s3api.ts` | `ListObjectsV2` paging and XML parsing. |
| `db.ts` | IndexedDB. The only module that persists anything. |
| `meta.ts` | Metadata provider interface + `MeasuredProvider`. |
| `justify.ts` | Row layout maths. Pure functions. |
| `grid.ts` | Sections, tiles, windowing, reflow. |
| `rail.ts` | Year timeline. |
| `lightbox.ts` | Full-resolution viewer. |
| `main.ts` | Wiring, first-run setup, error screens. |

Dependencies flow one way: `main` → everything, `grid` → `justify`/`meta`/`sigv4`, `s3api` → `sigv4`, `db` → nothing. `justify.ts` and `sigv4.ts` touch neither DOM nor storage, which is what makes them easy to test.

## Metadata provider

The grid never reads dimensions from storage directly. It asks a provider:

```ts
interface MetaProvider {
  get(key: string): Promise<PhotoMeta | undefined>;
  observe(key: string, w: number, h: number): void;
}
```

`MeasuredProvider` is what we build now — `get` reads the `meta` store, `observe` records dimensions from a loaded thumbnail. A `SqliteProvider` backed by the metadata DB can implement the same two methods later. Swapping them is one line in `main.ts`.

## Signing

Query-string SigV4, service `s3`, payload hash `UNSIGNED-PAYLOAD`, virtual-hosted addressing (`<bucket>.<endpoint>`). Session tokens are signed as the `X-Amz-Security-Token` query parameter.

Callers can pass extra query params — `response-content-type` is the only one we use. They're sorted in by name with everything else and signed the same way.

The derived signing key only depends on `(secret, date, region)`, so compute it once a day and reuse it. Signing 20,000 URLs then costs one four-step HMAC chain plus one HMAC each, instead of four each.

URLs get a one-hour lifetime and are signed lazily as sections mount, never for the whole manifest up front. If an image errors on an expired signature, re-sign once and retry before giving up.

## Listing

`ListObjectsV2`, paged to the end via `continuation-token`, parsed with `DOMParser`. No XML library.

On load, paint the cached manifest immediately and re-list in the background. Diff the result: add new keys into their date sections, drop removed ones, re-layout only the sections that changed. A cold start with no cache shows progress by page count.

## Storage

One IndexedDB database, `s3photos`, version 1, three stores.

| Store | Key | Contents |
|---|---|---|
| `creds` | singleton id | endpoint, region, bucket, access key, secret |
| `manifest` | object key | key, date, bytes |
| `meta` | object key | `w`, `h`; later labels, ocr, latlng, exif |

`meta` records carry only the fields the viewer needs today. Importing SQLite rows later means adding fields to records that already exist — no migration, no second store.

localStorage can't do this job. It caps around 5 MB, blocks the main thread, and holds strings only. The manifest alone is ~1.4 MB at 20,000 objects, OCR text at 500 bytes an image is 10 MB, and a SQLite file is binary so it wouldn't fit at any size.

## Layout

Justified rows preserving true aspect ratio. Accumulate tiles until `Σ(aspect) × targetHeight` exceeds the container width, then scale the row to fit exactly. Target height 200px, allowed to settle between 160 and 260.

Dimensions are unknown at first paint, so tiles start at 3:2. When a thumbnail loads, read its natural size, save it to `meta`, and re-justify **just that date section** on the next frame. Reflow never spreads past one day, so nothing jumps under the cursor. Once a section has been seen its sizes are cached for good and it never reflows again.

Date headers read `Tue, 29 Aug 2022`. The year is always shown — this is an archive, not a recent-activity feed.

## Windowing

Sections more than two viewport heights away are unmounted and replaced by a placeholder div holding their last measured height, driven by `IntersectionObserver`. A few thousand placeholder divs is fine; 20,000 live `<img>` elements is not. Mounted sections also use `loading="lazy"`.

Placeholders keep their measured heights, so scrolling stays stable across unmount and remount.

## Year rail

Pinned to the right edge, one label per year in the manifest. Labels are spaced by each year's photo **count**, which is known as soon as listing finishes and doesn't change when tiles reflow — so the rail is right from first paint and can't drift.

Clicking a year calls `scrollIntoView` on that year's first section: a real DOM anchor, not an estimated pixel offset. Dragging scrubs. The active year is tracked by watching section headers.

## Lightbox

Click a tile to open the full-resolution original at a freshly signed URL. Arrow keys and on-screen chevrons move through the flattened chronological order, across date and year boundaries. Escape closes and restores scroll position.

This is the one place extension matters: `.mp4` opens in `<video controls autoplay>`, everything else in `<img>`. Video tiles get a play badge in the grid, but their thumbnails were plain images like all the others. Neither element needs CORS.

## Theme

Dark only. Colours defined once as custom properties on `:root` — background `#121212`, raised surface `#1e1e1e`, text `#e8e8e8`, dim text `#9a9a9a`, plus an accent for the active year. No light mode, no toggle.

## Credentials and first run

With nothing stored, show a setup form: endpoint (default `https://s3.fr-par.scw.cloud`), region, bucket, access key, secret, optional session token. On submit, do a one-key `ListObjectsV2` to check it works before saving anything.

Credentials are stored in plaintext in `creds`. A "forget credentials" button clears them and returns to setup. The form says plainly that a read-only, bucket-scoped key is what belongs there.

## Error handling

| Condition | What the user sees |
|---|---|
| CORS failure | A dedicated screen explaining listing needs a CORS rule, with the exact rule to paste into Scaleway and the current origin filled in |
| `SignatureDoesNotMatch` | Back to setup, flagging a wrong region as the likeliest cause — it looks identical to a wrong secret |
| `AccessDenied` on list | Back to setup; the key is missing `s3:ListBucket` |
| `RequestTimeTooSkewed` | A banner saying the local clock has drifted |
| Thumbnail 404 or undecodable | Film-strip placeholder; the tile keeps its slot and still opens |
| Empty or unreadable manifest | Empty state describing the expected `YYYY/MM/DD/` layout |

A failed `fetch` looks the same whether it was CORS or the network being down, so the CORS screen mentions both instead of guessing.

## Build and serve

```
bun build src/main.ts --outdir dist --target browser            # build
bun build src/main.ts --outdir dist --target browser --watch    # dev
miniserve --index index.html --port 8080 .                      # serve
bunx tsc --noEmit                                               # type check
bun test                                                        # tests
```

`index.html` loads `<script type="module" src="dist/app.js">`. `dist/` is committed so it can be served from any static host without a build step.

Bun strips types without checking them, so `tsc --noEmit` is a real gate, not a formality. `typescript` is the only devDependency and there are no runtime dependencies.

## Testing

`bun test` covers the pure modules — where wrong logic fails quietly:

- **`sigv4.ts`** — fixtures checked against an independent implementation of the AWS spec with the clock pinned. Covers spaces, non-ASCII and parens in keys, and session tokens containing `/`, `+` and `=`.
- **`justify.ts`** — row breaking over known aspect sequences, rows filling width exactly, one very wide or very tall image degrading sanely, empty input giving no rows.
- **Key parsing** — accepts the documented layout, rejects `.thumbs/`, bad dates and unknown extensions.
- **Thumb URLs** — `.thumbs/` prefix, `response-content-type=image/jpeg` on every thumbnail regardless of extension, sorted into the right position.
- **Media kind** — `.mp4` is video, `.jpg`/`.jpeg` is image, case-insensitive; the thumbnail path never consults it.

DOM modules get checked by hand against the running app. No browser automation.

## Later

Listed so the design doesn't block them. Not being built now.

- **SQLite metadata import.** There's an existing SQLite DB of labels, OCR text, lat/long and EXIF. Either import its rows into `meta` and stay dependency-free, or ship sql.js (~1 MB wasm) and query it directly for real search over OCR text. Import unless search is wanted.
- **Prebuilt `index.json`.** Once dimensions come from SQLite, a generated index removes cold-start listing and first-browse reflow entirely. Same manifest shape, so it's purely additive.
- **Properly named video thumbnails.** If `.thumbs/` ever gets real `.jpg` posters, the `response-content-type` override just stops being needed.
