#!/usr/bin/env python
"""Build test/fixtures/search.db from scratch, at the phone's unified schema.

This script used to carve a fixture out of a real s3immich snapshot and
redact the secrets out of it. It no longer reads anything: every byte below
is synthetic, so there is nothing real to leak. The `AIza` tripwire at the
end is kept anyway, as a cheap guard against a future edit that pastes a
real Google key in where the placeholder is.

Usage:
    python tools/make_search_fixture.py test/fixtures/search.db

Schema
------
The DDL mirrors the phone branch column for column, in declaration order,
from `lib/infrastructure/db/gallery_schema.dart` (tables, primary keys,
`REFERENCES ... ON DELETE CASCADE`, `@TableIndex.sql` indexes) and
`lib/infrastructure/db/gallery_fts.dart` (the `gallery_fts` virtual table
and its three triggers). `month_day` is last in `gallery_asset` on purpose:
a production database gets it via `ALTER TABLE ... ADD COLUMN`, and the
phone's sync merge is positional. The `CHECK ("col" IN (0, 1))` constraints
on the boolean columns are what Drift itself emits for `BoolColumn`.

`store_entity` is not in the Drift file -- it predates it and rides along in
every push -- so its DDL is spelled out here:
`store_entity (id INTEGER PRIMARY KEY, string_value TEXT, int_value INTEGER)`.

The FTS5 table and triggers are created before any row is inserted, so the
triggers populate `gallery_fts` for real. That is deliberate: the committed
fixture is the proof that sql.js can open a database containing an FTS5
virtual table and triggers (see `test/search/sqljs.test.ts`).

Fixture contents
----------------
`gallery_asset` has ASSET_COUNT (8) rows: six renderable, two excluded by
the viewer's renderable filter (`remote_key <> '' AND visibility = 0`).

Text columns imitate how the phone writes them. `name_normalized`,
`label_text` and `camera_text` arrive already folded by `foldForSearch`:
lowercased, diacritics stripped, every run of non-alphanumerics collapsed to
one space, trimmed -- `IMG_4821.jpg` becomes `img 4821 jpg`, and labels
`Passenger Train` + `Dog` become `passenger train dog` (confidence
descending, deduplicated, space-joined). `ocr_text` is raw recognizer output
and keeps its case, punctuation and diacritics.

Tokens below are what `normalize()` in `src/search/tokenize.ts` yields for
each column -- the viewer's index side, which emulates FTS5 `unicode61` with
`remove_diacritics 1`. Note `ærø` and `glædelig`: NFD leaves `æ` and `ø`
alone, so they stay in the index un-de-accented.

Every row with a `remote_key` also lands in the asset table
(`ImportResult.assets`) whatever its visibility, carrying `width`/`height`
and the non-empty companion keys (`thumb_key`, `live_photo_key`,
`face_sidecar_key`). ASSET_TRAIN_PLATFORM is the one row with all three
companions; ASSET_SUNSET_PUNCTUATION has none.

RENDERABLE (six rows; `keys`, sorted by `remote_key`, is exactly these):

1. ASSET_TRAIN_PLATFORM -- `2024/03/14/IMG_4821.jpg`
   name    `img 4821 jpg`         -> img, 4821, jpg
   label   `passenger train dog`  -> passenger, train, dog
   camera  `fujifilm x t5`        -> fujifilm, x, t5
   ocr     `Perron 3 — Afgang 14:05` -> perron, 3, afgang, 14, 05
   geo     55.6761 / 12.5683

2. ASSET_TRAIN_CAFE -- `2024/03/14/IMG_4822.jpg`
   name    `img 4822 jpg`         -> img, 4822, jpg
   label   `passenger train`      -> passenger, train
   camera  `` (none)
   ocr     `Café Crème — 45,00 kr.` -> cafe, creme, 45, 00, kr
           NFD decomposes é and è, so the accents come off in the index.
   geo     48.8584 / 2.2945

3. ASSET_DOG_PORTRAIT -- `2024/05/02/DSC_0007.JPG`
   name    `dsc 0007 jpg`         -> dsc, 0007, jpg
   label   `dog`                  -> dog
   camera  `nikon d750`           -> nikon, d750
   ocr     `` (none)
   geo     51.5072 / -0.1276

4. ASSET_SUNSET_PUNCTUATION -- `2024/07/19/PXL_20240719_101530123.jpg`
   name    `pxl 20240719 101530123 jpg` -> pxl, 20240719, 101530123, jpg
   label   `sunset`               -> sunset
   camera  `` (none)
   ocr     `--- *** !!! ...`      -> nothing; normalizes to the empty string
   geo     none: has_location = 0, latitude and longitude at their 0.0
           defaults. The only unlocated row.
   size    none: width and height at their 0 defaults, and no thumb_key.
           The only row with no dimensions and no companions.

5. ASSET_SAILBOAT_AERO -- `2024/08/05/IMG_5099.jpg`
   name    `img 5099 jpg`         -> img, 5099, jpg
   label   `sailboat`             -> sailboat
   camera  `` (none)
   ocr     `Velkommen til Ærø!`   -> velkommen, til, ærø
           A query for `Ærø` folds to `aero` and does not match. That
           asymmetry is inherited from the phone and is documented, not fixed.
   geo     54.8878 / 10.4094

6. ASSET_BICYCLE_BENCH -- `2024/11/23/IMG_6410.jpg`
   name    `img 6410 jpg`         -> img, 6410, jpg
   label   `bicycle bench`        -> bicycle, bench
   camera  `apple iphone 15 pro`  -> apple, iphone, 15, pro
   ocr     `Cykelparkering forbudt.` -> cykelparkering, forbudt
   geo     35.6595 / 139.7005

EXCLUDED (present in the file, absent from every extraction):

7. ASSET_LOCAL_ONLY -- `remote_key = ''`, visibility 0, local_id `local-0007`
   name `img 9001 jpg`; label `local only sign`; ocr `Kun på telefonen`
   -> kun, pa, telefonen. Carries has_location = 1 at 40.7128 / -74.0060,
   so `geo` dropping it proves geo honours the renderable filter and not
   just `has_location`.

8. ASSET_ARCHIVED -- `2024/12/24/IMG_7777.jpg`, visibility 2 (archive)
   name `img 7777 jpg`; label `christmas tree`; camera `canon eos r6`;
   ocr `Glædelig jul` -> glædelig, jul. Also has_location = 1, at
   59.3293 / 18.0686.

Apart from the generic `img` and `jpg`, which rows 7 and 8 share with the
renderable ones, every token those two rows carry is theirs alone. So
`9001`, `local`, `only`, `sign`, `kun`, `pa`, `telefonen`, `7777`,
`christmas`, `tree`, `canon`, `eos`, `r6`, `glædelig` and `jul` must be
absent from `terms` entirely -- their presence would mean an excluded row
leaked into the index.

Useful token overlaps: `jpg` is on all six renderable rows, `img` on rows
1, 2, 5 and 6, `passenger` and `train` on rows 1 and 2, `dog` on rows 1
and 3.

`gallery_label` (LABEL_COUNT = 10 rows) carries the raw, unfolded label text
and a confidence, one row per label per asset. `local only sign` exists only
on the local-only asset and `christmas tree` only on the archived one.

`label_embedding` (EMBEDDING_COUNT = 7 rows), each a 3072-byte blob of 768
little-endian float32 values -- big enough to spill into an overflow page:

  passenger train  gemini-embedding-001  one-hot-ish: v[0] = 1.0, rest 0.001.
                                         Deliberately far from every other
                                         vector, so a cosine test can pick it.
  dog              gemini-embedding-001  pseudo-random, seeded by the label
  sunset           gemini-embedding-001  pseudo-random, seeded by the label
  sailboat         gemini-embedding-001  pseudo-random, seeded by the label
  bicycle          gemini-embedding-001  pseudo-random, seeded by the label
  local only sign  gemini-embedding-001  dropped: not a live label
  bench            other-model           dropped: wrong model, even though
                                         `bench` IS a live label

So an import restricted to `gemini-embedding-001` and to labels on
renderable rows keeps exactly five: bicycle, dog, passenger train, sailboat,
sunset.

`store_entity` has one row, id 2002, whose `string_value` is
PLACEHOLDER_KEY. Nothing else is in the table.
"""
import hashlib
import shutil
import sqlite3
import struct
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

PLACEHOLDER_KEY = '{"apiKey":"AIzaSyFIXTURE-not-a-real-key-000000000000"}'

# The one model the viewer imports. Must match EMBEDDING_MODEL in
# src/search/suggest.ts.
EMBEDDING_MODEL = "gemini-embedding-001"

# 768 float32 values, 3072 bytes -- the width src/search/import.ts expects.
DIMENSIONS = 768


def ms(iso: str) -> int:
    """Epoch milliseconds for a UTC timestamp like `2024-03-14T09:15:00`."""
    return int(datetime.fromisoformat(iso).replace(tzinfo=timezone.utc).timestamp() * 1000)


# --- schema ----------------------------------------------------------------
# Copied from lib/infrastructure/db/gallery_schema.dart, in declaration
# order. TextColumn -> TEXT, IntColumn/BoolColumn/intEnum -> INTEGER,
# RealColumn -> REAL, BlobColumn -> BLOB; every column NOT NULL with the
# declared default.

SCHEMA = """
CREATE TABLE gallery_asset (
    checksum TEXT NOT NULL DEFAULT '',
    type INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    name_normalized TEXT NOT NULL DEFAULT '',
    local_id TEXT NOT NULL DEFAULT '',
    remote_key TEXT NOT NULL DEFAULT '',
    thumb_key TEXT NOT NULL DEFAULT '',
    live_photo_key TEXT NOT NULL DEFAULT '',
    face_sidecar_key TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    orientation INTEGER NOT NULL DEFAULT 0,
    sort_time_utc_ms INTEGER NOT NULL DEFAULT 0,
    added_at_utc_ms INTEGER NOT NULL DEFAULT 0,
    file_modified_utc_ms INTEGER NOT NULL DEFAULT 0,
    latitude REAL NOT NULL DEFAULT 0.0,
    longitude REAL NOT NULL DEFAULT 0.0,
    has_location INTEGER NOT NULL DEFAULT 0 CHECK ("has_location" IN (0, 1)),
    place_city TEXT NOT NULL DEFAULT '',
    place_state TEXT NOT NULL DEFAULT '',
    place_country TEXT NOT NULL DEFAULT '',
    camera_make TEXT NOT NULL DEFAULT '',
    camera_model TEXT NOT NULL DEFAULT '',
    lens TEXT NOT NULL DEFAULT '',
    iso INTEGER NOT NULL DEFAULT 0,
    f_number REAL NOT NULL DEFAULT 0.0,
    exposure_time TEXT NOT NULL DEFAULT '',
    focal_length REAL NOT NULL DEFAULT 0.0,
    file_size_bytes INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT NOT NULL DEFAULT '',
    is_favorite INTEGER NOT NULL DEFAULT 0 CHECK ("is_favorite" IN (0, 1)),
    visibility INTEGER NOT NULL DEFAULT 0,
    backup_state INTEGER NOT NULL DEFAULT 0,
    backed_up_at_utc_ms INTEGER NOT NULL DEFAULT 0,
    backup_attempts INTEGER NOT NULL DEFAULT 0,
    backup_error TEXT NOT NULL DEFAULT '',
    face_scanned_at_ms INTEGER NOT NULL DEFAULT 0,
    ocr_scanned_at_ms INTEGER NOT NULL DEFAULT 0,
    label_scanned_at_ms INTEGER NOT NULL DEFAULT 0,
    label_model TEXT NOT NULL DEFAULT '',
    label_failures INTEGER NOT NULL DEFAULT 0,
    ocr_text TEXT NOT NULL DEFAULT '',
    label_text TEXT NOT NULL DEFAULT '',
    camera_text TEXT NOT NULL DEFAULT '',
    month_day TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (checksum)
);

CREATE INDEX IF NOT EXISTS idx_asset_sort ON gallery_asset (visibility, sort_time_utc_ms DESC);
CREATE INDEX IF NOT EXISTS idx_asset_backup ON gallery_asset (backup_state);
CREATE INDEX IF NOT EXISTS idx_asset_label_scan ON gallery_asset (label_scanned_at_ms, label_failures);
CREATE INDEX IF NOT EXISTS idx_asset_local ON gallery_asset (local_id);
CREATE INDEX IF NOT EXISTS idx_asset_remote ON gallery_asset (remote_key);
CREATE INDEX IF NOT EXISTS idx_asset_month_day ON gallery_asset (visibility, month_day);

CREATE TABLE gallery_label (
    checksum TEXT NOT NULL REFERENCES gallery_asset (checksum) ON DELETE CASCADE,
    label TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.0,
    box_x REAL NOT NULL DEFAULT 0.0,
    box_y REAL NOT NULL DEFAULT 0.0,
    box_width REAL NOT NULL DEFAULT 0.0,
    box_height REAL NOT NULL DEFAULT 0.0,
    PRIMARY KEY (checksum, label)
);

CREATE TABLE gallery_face (
    face_id TEXT NOT NULL,
    checksum TEXT NOT NULL REFERENCES gallery_asset (checksum) ON DELETE CASCADE,
    person_id TEXT NOT NULL DEFAULT '',
    image_width INTEGER NOT NULL DEFAULT 0,
    image_height INTEGER NOT NULL DEFAULT 0,
    bounding_box_x1 INTEGER NOT NULL DEFAULT 0,
    bounding_box_y1 INTEGER NOT NULL DEFAULT 0,
    bounding_box_x2 INTEGER NOT NULL DEFAULT 0,
    bounding_box_y2 INTEGER NOT NULL DEFAULT 0,
    has_embedding INTEGER NOT NULL DEFAULT 0 CHECK ("has_embedding" IN (0, 1)),
    PRIMARY KEY (face_id)
);

CREATE INDEX IF NOT EXISTS idx_face_person ON gallery_face (person_id, checksum);

CREATE TABLE person (
    person_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    cover_face_id TEXT NOT NULL DEFAULT '',
    is_confirmed INTEGER NOT NULL DEFAULT 0 CHECK ("is_confirmed" IN (0, 1)),
    PRIMARY KEY (person_id)
);

CREATE TABLE album (
    album_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (album_id)
);

CREATE TABLE gallery_album_asset (
    album_id TEXT NOT NULL REFERENCES album (album_id) ON DELETE CASCADE,
    checksum TEXT NOT NULL REFERENCES gallery_asset (checksum) ON DELETE CASCADE,
    PRIMARY KEY (album_id, checksum)
);

CREATE INDEX IF NOT EXISTS idx_album_asset_checksum ON gallery_album_asset (checksum);

CREATE TABLE label_embedding (
    label TEXT NOT NULL,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    resolved_at_utc_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (label)
);

CREATE TABLE import_failure (
    local_id TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 1,
    last_try_utc_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (local_id)
);

-- Not in the Drift file: predates it, and rides along in every push.
CREATE TABLE store_entity (
    id INTEGER PRIMARY KEY,
    string_value TEXT,
    int_value INTEGER
);
"""

# Verbatim from lib/infrastructure/db/gallery_fts.dart. Created before any
# row is inserted, so the AFTER INSERT trigger fills the index for real.
FTS_VTAB_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS gallery_fts USING fts5(
    name_normalized, label_text, ocr_text, camera_text,
    content = 'gallery_asset', content_rowid = 'rowid',
    tokenize = 'unicode61', prefix = '2 3'
);
"""

# Kept apart from the vtab above so the "no FTS5" bail-out below can only
# ever fire on the CREATE VIRTUAL TABLE. Folded together, a plain syntax
# error in a trigger would be reported as a missing FTS5 module.
FTS_TRIGGER_SCHEMA = """
CREATE TRIGGER IF NOT EXISTS gallery_fts_ai AFTER INSERT ON gallery_asset BEGIN
  INSERT INTO gallery_fts(rowid, name_normalized, label_text, ocr_text, camera_text)
  VALUES (new.rowid, new.name_normalized, new.label_text, new.ocr_text, new.camera_text);
END;

CREATE TRIGGER IF NOT EXISTS gallery_fts_ad AFTER DELETE ON gallery_asset BEGIN
  INSERT INTO gallery_fts(gallery_fts, rowid, name_normalized, label_text, ocr_text, camera_text)
  VALUES ('delete', old.rowid, old.name_normalized, old.label_text, old.ocr_text, old.camera_text);
END;

CREATE TRIGGER IF NOT EXISTS gallery_fts_au AFTER UPDATE ON gallery_asset BEGIN
  INSERT INTO gallery_fts(gallery_fts, rowid, name_normalized, label_text, ocr_text, camera_text)
  VALUES ('delete', old.rowid, old.name_normalized, old.label_text, old.ocr_text, old.camera_text);
  INSERT INTO gallery_fts(rowid, name_normalized, label_text, ocr_text, camera_text)
  VALUES (new.rowid, new.name_normalized, new.label_text, new.ocr_text, new.camera_text);
END;
"""

# --- rows ------------------------------------------------------------------
# Every row is a named constant so the import tests can refer to it. Columns
# not listed keep their DDL default, which is also a check that the defaults
# are right. `type` 1 is image (0 other, 2 video); `visibility` 0 is
# timeline, 1 hidden, 2 archive, 3 locked.

ASSET_TRAIN_PLATFORM = {
    "checksum": "0000000000000000000000000000000000000000000000000000000000000001",
    "type": 1,
    "name": "IMG_4821.jpg",
    "name_normalized": "img 4821 jpg",
    "local_id": "local-0001",
    "remote_key": "2024/03/14/IMG_4821.jpg",
    "thumb_key": "2024/03/14/thumb/IMG_4821.jpg",
    # A live photo: the phone uploads the paired video under the original's
    # date path with the video's own extension, and the ML pass later stamps
    # a face sidecar. Both are companions the viewer deletes with the photo.
    "live_photo_key": "2024/03/14/IMG_4821.MOV",
    "face_sidecar_key": ".faces/2024/03/14/IMG_4821.jpg.json.gz",
    "width": 4032,
    "height": 3024,
    "sort_time_utc_ms": ms("2024-03-14T09:15:00"),
    "added_at_utc_ms": ms("2024-03-14T09:20:00"),
    "file_modified_utc_ms": ms("2024-03-14T09:15:00"),
    "latitude": 55.6761,
    "longitude": 12.5683,
    "has_location": 1,
    "place_city": "København",
    "place_country": "Denmark",
    "camera_make": "FUJIFILM",
    "camera_model": "X-T5",
    "iso": 200,
    "f_number": 2.8,
    "exposure_time": "1/250",
    "focal_length": 23.0,
    "file_size_bytes": 3145728,
    "mime_type": "image/jpeg",
    "ocr_text": "Perron 3 — Afgang 14:05",
    "label_text": "passenger train dog",
    "camera_text": "fujifilm x t5",
    "month_day": "03-14",
}

ASSET_TRAIN_CAFE = {
    "checksum": "0000000000000000000000000000000000000000000000000000000000000002",
    "type": 1,
    "name": "IMG_4822.jpg",
    "name_normalized": "img 4822 jpg",
    "local_id": "local-0002",
    "remote_key": "2024/03/14/IMG_4822.jpg",
    "thumb_key": "2024/03/14/thumb/IMG_4822.jpg",
    "width": 4032,
    "height": 3024,
    "sort_time_utc_ms": ms("2024-03-14T11:02:00"),
    "added_at_utc_ms": ms("2024-03-14T11:10:00"),
    "file_modified_utc_ms": ms("2024-03-14T11:02:00"),
    "latitude": 48.8584,
    "longitude": 2.2945,
    "has_location": 1,
    "place_city": "Paris",
    "place_country": "France",
    "file_size_bytes": 2621440,
    "mime_type": "image/jpeg",
    # Raw recognizer output: accents and punctuation survive into the column.
    "ocr_text": "Café Crème — 45,00 kr.",
    "label_text": "passenger train",
    "month_day": "03-14",
}

ASSET_DOG_PORTRAIT = {
    "checksum": "0000000000000000000000000000000000000000000000000000000000000003",
    "type": 1,
    "name": "DSC_0007.JPG",
    "name_normalized": "dsc 0007 jpg",
    "local_id": "local-0003",
    "remote_key": "2024/05/02/DSC_0007.JPG",
    "thumb_key": "2024/05/02/thumb/DSC_0007.JPG",
    "width": 6016,
    "height": 4016,
    "sort_time_utc_ms": ms("2024-05-02T16:40:00"),
    "added_at_utc_ms": ms("2024-05-02T17:00:00"),
    "file_modified_utc_ms": ms("2024-05-02T16:40:00"),
    "latitude": 51.5072,
    "longitude": -0.1276,
    "has_location": 1,
    "place_city": "London",
    "place_country": "United Kingdom",
    "camera_make": "Nikon",
    "camera_model": "D750",
    "iso": 400,
    "f_number": 1.8,
    "exposure_time": "1/500",
    "focal_length": 50.0,
    "file_size_bytes": 8388608,
    "mime_type": "image/jpeg",
    "label_text": "dog",
    "camera_text": "nikon d750",
    "month_day": "05-02",
}

ASSET_SUNSET_PUNCTUATION = {
    "checksum": "0000000000000000000000000000000000000000000000000000000000000004",
    "type": 1,
    "name": "PXL_20240719_101530123.jpg",
    "name_normalized": "pxl 20240719 101530123 jpg",
    "local_id": "local-0004",
    "remote_key": "2024/07/19/PXL_20240719_101530123.jpg",
    # No thumb_key and width/height at their 0 defaults: a row recorded by a
    # phone that had neither a thumbnail nor dimensions for it. The viewer
    # falls back to the conventional `.thumbs/` twin and to measuring.
    "sort_time_utc_ms": ms("2024-07-19T10:15:30"),
    "added_at_utc_ms": ms("2024-07-19T10:20:00"),
    "file_modified_utc_ms": ms("2024-07-19T10:15:30"),
    # The unlocated row: has_location 0, coordinates left at the 0.0 default.
    "file_size_bytes": 2097152,
    "mime_type": "image/jpeg",
    # Normalizes to the empty string; contributes no tokens at all.
    "ocr_text": "--- *** !!! ...",
    "label_text": "sunset",
    "month_day": "07-19",
}

ASSET_SAILBOAT_AERO = {
    "checksum": "0000000000000000000000000000000000000000000000000000000000000005",
    "type": 1,
    "name": "IMG_5099.jpg",
    "name_normalized": "img 5099 jpg",
    "local_id": "local-0005",
    "remote_key": "2024/08/05/IMG_5099.jpg",
    "thumb_key": "2024/08/05/thumb/IMG_5099.jpg",
    "width": 4032,
    "height": 3024,
    "sort_time_utc_ms": ms("2024-08-05T13:05:00"),
    "added_at_utc_ms": ms("2024-08-05T13:30:00"),
    "file_modified_utc_ms": ms("2024-08-05T13:05:00"),
    "latitude": 54.8878,
    "longitude": 10.4094,
    "has_location": 1,
    "place_city": "Ærøskøbing",
    "place_country": "Denmark",
    "file_size_bytes": 2936012,
    "mime_type": "image/jpeg",
    # Indexed as `ærø`: NFD leaves æ and ø alone. A typed query folds to
    # `aero` and misses -- the asymmetry the spec documents.
    "ocr_text": "Velkommen til Ærø!",
    "label_text": "sailboat",
    "month_day": "08-05",
}

ASSET_BICYCLE_BENCH = {
    "checksum": "0000000000000000000000000000000000000000000000000000000000000006",
    "type": 1,
    "name": "IMG_6410.jpg",
    "name_normalized": "img 6410 jpg",
    "local_id": "local-0006",
    "remote_key": "2024/11/23/IMG_6410.jpg",
    "thumb_key": "2024/11/23/thumb/IMG_6410.jpg",
    "width": 4284,
    "height": 5712,
    "sort_time_utc_ms": ms("2024-11-23T08:45:00"),
    "added_at_utc_ms": ms("2024-11-23T09:00:00"),
    "file_modified_utc_ms": ms("2024-11-23T08:45:00"),
    "latitude": 35.6595,
    "longitude": 139.7005,
    "has_location": 1,
    "place_city": "Tokyo",
    "place_country": "Japan",
    "camera_make": "Apple",
    "camera_model": "iPhone 15 Pro",
    "iso": 64,
    "f_number": 1.78,
    "exposure_time": "1/120",
    "focal_length": 6.765,
    "file_size_bytes": 4194304,
    "mime_type": "image/jpeg",
    "ocr_text": "Cykelparkering forbudt.",
    "label_text": "bicycle bench",
    "camera_text": "apple iphone 15 pro",
    "month_day": "11-23",
}

# Excluded: no remote object, so nothing to render. Located on purpose --
# the geo extraction must drop it because of the renderable filter, not
# because it lacks coordinates.
ASSET_LOCAL_ONLY = {
    "checksum": "0000000000000000000000000000000000000000000000000000000000000007",
    "type": 1,
    "name": "IMG_9001.jpg",
    "name_normalized": "img 9001 jpg",
    "local_id": "local-0007",
    "remote_key": "",
    "width": 3024,
    "height": 4032,
    "sort_time_utc_ms": ms("2024-09-01T18:22:00"),
    "added_at_utc_ms": ms("2024-09-01T18:25:00"),
    "file_modified_utc_ms": ms("2024-09-01T18:22:00"),
    "latitude": 40.7128,
    "longitude": -74.0060,
    "has_location": 1,
    "place_city": "New York",
    "place_country": "United States",
    "file_size_bytes": 1572864,
    "mime_type": "image/jpeg",
    "ocr_text": "Kun på telefonen",
    "label_text": "local only sign",
    "month_day": "09-01",
}

# Excluded: archived. The object exists in the bucket, but the phone hides
# archived photos from search and so does the viewer.
ASSET_ARCHIVED = {
    "checksum": "0000000000000000000000000000000000000000000000000000000000000008",
    "type": 1,
    "name": "IMG_7777.jpg",
    "name_normalized": "img 7777 jpg",
    "local_id": "local-0008",
    "remote_key": "2024/12/24/IMG_7777.jpg",
    "thumb_key": "2024/12/24/thumb/IMG_7777.jpg",
    "width": 5472,
    "height": 3648,
    "sort_time_utc_ms": ms("2024-12-24T19:00:00"),
    "added_at_utc_ms": ms("2024-12-24T19:30:00"),
    "file_modified_utc_ms": ms("2024-12-24T19:00:00"),
    "latitude": 59.3293,
    "longitude": 18.0686,
    "has_location": 1,
    "place_city": "Stockholm",
    "place_country": "Sweden",
    "camera_make": "Canon",
    "camera_model": "EOS R6",
    "iso": 1600,
    "f_number": 4.0,
    "exposure_time": "1/60",
    "focal_length": 35.0,
    "file_size_bytes": 6291456,
    "mime_type": "image/jpeg",
    "visibility": 2,
    "ocr_text": "Glædelig jul",
    "label_text": "christmas tree",
    "camera_text": "canon eos r6",
    "month_day": "12-24",
}

RENDERABLE_ASSETS = [
    ASSET_TRAIN_PLATFORM,
    ASSET_TRAIN_CAFE,
    ASSET_DOG_PORTRAIT,
    ASSET_SUNSET_PUNCTUATION,
    ASSET_SAILBOAT_AERO,
    ASSET_BICYCLE_BENCH,
]

EXCLUDED_ASSETS = [ASSET_LOCAL_ONLY, ASSET_ARCHIVED]

ASSETS = RENDERABLE_ASSETS + EXCLUDED_ASSETS
ASSET_COUNT = len(ASSETS)

# (asset, raw label, confidence). The label column keeps the recognizer's
# original casing; `label_text` on the asset is the folded, confidence-sorted
# join of these.
LABELS = [
    (ASSET_TRAIN_PLATFORM, "Passenger Train", 0.92),
    (ASSET_TRAIN_PLATFORM, "Dog", 0.71),
    (ASSET_TRAIN_CAFE, "Passenger Train", 0.88),
    (ASSET_DOG_PORTRAIT, "Dog", 0.95),
    (ASSET_SUNSET_PUNCTUATION, "Sunset", 0.81),
    (ASSET_SAILBOAT_AERO, "Sailboat", 0.77),
    (ASSET_BICYCLE_BENCH, "Bicycle", 0.68),
    (ASSET_BICYCLE_BENCH, "Bench", 0.52),
    (ASSET_LOCAL_ONLY, "Local Only Sign", 0.99),
    (ASSET_ARCHIVED, "Christmas Tree", 0.84),
]
LABEL_COUNT = len(LABELS)

# The label whose vector is deliberately unlike every other, so a cosine
# test has an unambiguous nearest neighbour to find.
DISTINCT_EMBEDDING_LABEL = "passenger train"

# (label, model). `label_embedding.label` is stored lowercased, as the phone
# writes it. `bench` is a live label held back to `other-model` so the model
# filter is tested on its own, independently of the live-label restriction.
EMBEDDINGS = [
    ("passenger train", EMBEDDING_MODEL),
    ("dog", EMBEDDING_MODEL),
    ("sunset", EMBEDDING_MODEL),
    ("sailboat", EMBEDDING_MODEL),
    ("bicycle", EMBEDDING_MODEL),
    ("local only sign", EMBEDDING_MODEL),
    ("bench", "other-model"),
]
EMBEDDING_COUNT = len(EMBEDDINGS)


def embedding_for(label: str) -> bytes:
    """3072 deterministic, non-zero bytes: 768 little-endian float32 values.

    Seeded from the label's SHA-256 so the committed fixture is byte-stable
    across machines and Python versions -- `random` is not promised to be.
    `DISTINCT_EMBEDDING_LABEL` gets a one-hot-ish vector instead, far from
    every pseudo-random one under cosine similarity.
    """
    if label == DISTINCT_EMBEDDING_LABEL:
        values = [0.001] * DIMENSIONS
        values[0] = 1.0
        return struct.pack(f"<{DIMENSIONS}f", *values)

    state = int.from_bytes(hashlib.sha256(label.encode("utf-8")).digest()[:8], "big") | 1
    values = []
    for _ in range(DIMENSIONS):
        # A 64-bit LCG (the constants are Knuth's MMIX ones), taken to a
        # float in (-1, 1). Nudged off zero so no value in the blob is 0.0.
        state = (state * 6364136223846793005 + 1442695040888963407) % (1 << 64)
        value = ((state >> 11) / float(1 << 53)) * 2.0 - 1.0
        values.append(value if value != 0.0 else 1e-6)
    return struct.pack(f"<{DIMENSIONS}f", *values)


def insert_asset(db: sqlite3.Connection, asset: dict) -> None:
    """Insert one asset, letting the DDL defaults fill every column it omits."""
    columns = list(asset.keys())
    placeholders = ", ".join("?" * len(columns))
    db.execute(
        f"INSERT INTO gallery_asset ({', '.join(columns)}) VALUES ({placeholders})",
        [asset[column] for column in columns],
    )


def build(dest: Path) -> None:
    dest.unlink(missing_ok=True)

    db = sqlite3.connect(dest)
    db.executescript(SCHEMA)

    # FTS5 is a compile-time option. Bail loudly rather than commit a fixture
    # that silently lacks the virtual table the sqljs test exists to prove.
    try:
        db.executescript(FTS_VTAB_SCHEMA)
    except sqlite3.OperationalError as error:
        sys.exit(
            f"this Python's SQLite {sqlite3.sqlite_version} cannot create the FTS5 table"
            f" ({error}); the fixture would be missing gallery_fts, so refusing to write it"
        )

    db.executescript(FTS_TRIGGER_SCHEMA)

    for asset in ASSETS:
        insert_asset(db, asset)

    for asset, label, confidence in LABELS:
        db.execute(
            "INSERT INTO gallery_label (checksum, label, confidence) VALUES (?, ?, ?)",
            (asset["checksum"], label, confidence),
        )

    for label, model in EMBEDDINGS:
        db.execute(
            "INSERT INTO label_embedding (label, embedding, model, resolved_at_utc_ms)"
            " VALUES (?, ?, ?, ?)",
            (label, embedding_for(label), model, ms("2024-12-31T00:00:00")),
        )

    db.execute(
        "INSERT INTO store_entity (id, string_value, int_value) VALUES (2002, ?, NULL)",
        (PLACEHOLDER_KEY,),
    )

    db.commit()

    # Query through the index, not COUNT(*). gallery_fts is an external-
    # content table: a bare COUNT(*) reads gallery_asset and returns 8
    # whether or not a single posting was ever written. A MATCH has to walk
    # the index itself, so it is zero when the triggers did not fire. Every
    # fixture row's name_normalized ends in `jpg`, so a correct index has
    # exactly one hit per asset.
    indexed = db.execute(
        "SELECT COUNT(*) FROM gallery_fts WHERE gallery_fts MATCH 'jpg'"
    ).fetchone()[0]
    if indexed != ASSET_COUNT:
        sys.exit(
            f"gallery_fts matched {indexed} rows for 'jpg', expected {ASSET_COUNT}"
            " -- triggers did not fire"
        )

    db.execute("VACUUM")
    db.commit()
    db.close()


def tripwire(dest: Path) -> None:
    """Fail if the file carries an `AIza` string other than the placeholder.

    Scans the bytes on disk rather than the rows we meant to write: VACUUM
    rewrites the file, and a stale copy on a free page would still ship.
    Nothing real goes into this fixture any more, so this is belt-and-braces
    against a future edit that pastes a live Google key in.
    """
    data = dest.read_bytes()
    if PLACEHOLDER_KEY.encode("ascii") not in data:
        sys.exit("the placeholder API key is not in the written file")

    marker = b"AIzaSyFIXTURE"
    pos = data.find(b"AIza")
    while pos != -1:
        if data[pos : pos + len(marker)] != marker:
            sys.exit("found an AIza-prefixed string that is not the placeholder")
        pos = data.find(b"AIza", pos + 1)


def main(dest: str) -> None:
    path = Path(dest)
    path.parent.mkdir(parents=True, exist_ok=True)

    # Build and check somewhere else, and only then overwrite the committed
    # file: a run that bails -- no FTS5, a trigger that did not fire, a
    # tripwire hit -- must leave the good fixture in place rather than
    # replacing it with a broken one.
    staging = Path(tempfile.mkdtemp()) / "search.db"
    try:
        build(staging)
        tripwire(staging)
        shutil.copy(staging, path)
    finally:
        shutil.rmtree(staging.parent, ignore_errors=True)

    print(
        f"wrote {dest} ({path.stat().st_size} bytes): {ASSET_COUNT} gallery_asset rows"
        f" ({len(RENDERABLE_ASSETS)} renderable), {LABEL_COUNT} gallery_label rows,"
        f" {EMBEDDING_COUNT} label_embedding rows, gallery_fts populated by trigger;"
        " tripwire clean, only the placeholder API key present"
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
