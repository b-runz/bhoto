#!/usr/bin/env python
"""Carve a tiny search fixture out of a real s3immich snapshot.

The output is committed to git. `store_entity` in the source DB carries live
secrets -- id 2000 is a JSON blob with the bucket's accessKey/secretKey, id
2002 is a Google API key -- and nothing in src/search/import.ts reads any row
other than id 2002. So redaction here is whitelist-based: id 2002 is kept and
replaced with a placeholder, and every other store_entity row is deleted.
Nothing else about the schema changes -- the point of the fixture is that
sql.js meets the real thing: WITHOUT ROWID tables stored as index b-trees, 3 KB
embedding blobs that spill into overflow pages, and OCR rows whose asset_id is
a phone-local numeric ID rather than an S3 key.

Usage:
    python tools/make_search_fixture.py <source.db> test/fixtures/search.db
"""
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

PLACEHOLDER_KEY = '{"apiKey":"AIzaSyFIXTURE-not-a-real-key-000000000000"}'

# Any of these appearing in the destination bytes after redaction (other than
# the placeholder itself) means a secret survived. Checked defensively below,
# on the actual bytes written to disk -- not just the rows we intended to
# touch, since sqlite's free-page reuse could leave stale copies elsewhere in
# the file after VACUUM does its rewrite.
FORBIDDEN_SUBSTRINGS = (b"accessKey", b"secretKey")

# Assets the fixture keeps. Chosen so the extraction queries have something
# to include AND something to exclude.
KEEP = 8


def main(source: str, dest: str) -> None:
    tmp = Path(tempfile.mkdtemp()) / "fixture.db"
    shutil.copy(source, tmp)
    db = sqlite3.connect(tmp)

    live = [r[0] for r in db.execute(
        "SELECT id FROM remote_asset_entity WHERE deleted_at IS NULL"
        " AND id IN (SELECT c0 FROM asset_fts_content WHERE c1 IS NOT NULL AND c1 <> '')"
        " ORDER BY id LIMIT ?", (KEEP,))]
    if len(live) < KEEP:
        sys.exit(f"source has only {len(live)} usable assets, need {KEEP}")

    # One extra asset that is soft-deleted: every extraction query must
    # exclude it, and a test asserts that it does.
    deleted = live[-1]
    live = live[:-1]
    db.execute("UPDATE remote_asset_entity SET deleted_at = '2026-01-01T00:00:00.000Z'"
               " WHERE id = ?", (deleted,))
    keep = live + [deleted]
    marks = ",".join("?" * len(keep))

    db.execute(f"DELETE FROM remote_asset_entity WHERE id NOT IN ({marks})", keep)
    db.execute(f"DELETE FROM remote_exif_entity WHERE asset_id NOT IN ({marks})", keep)
    db.execute(f"DELETE FROM asset_label_entity WHERE asset_id NOT IN ({marks})", keep)
    db.execute(f"DELETE FROM asset_fts_content WHERE c0 NOT IN ({marks})", keep)

    # A local-only OCR row: c0 is a phone-local numeric ID, not an S3 key.
    # The join in the extraction query is what filters it out.
    db.execute("INSERT INTO asset_fts_content (id, c0, c1, c2)"
               " VALUES ((SELECT MAX(id) + 1 FROM asset_fts_content),"
               " '1000000020', 'local only receipt', '')")

    # A label attached only to a local asset, for the same reason.
    db.execute("INSERT INTO asset_label_entity (asset_id, label, source, confidence)"
               " VALUES ('1000000020', 'local only label', 'fixture', 1.0)")

    # Keep embeddings only for labels the fixture still references, plus one
    # dead end that must be dropped at import.
    db.execute("DELETE FROM label_embedding_entity WHERE LOWER(label) NOT IN"
               " (SELECT LOWER(label) FROM asset_label_entity)")
    db.execute("INSERT OR REPLACE INTO label_embedding_entity"
               " (label, embedding, model, resolved_at)"
               " SELECT 'dead end label', embedding, model, resolved_at"
               " FROM label_embedding_entity LIMIT 1")

    db.execute("DELETE FROM asset_face_entity")
    db.execute("DELETE FROM local_asset_entity")
    db.execute("DELETE FROM local_album_asset_entity")
    db.execute("DELETE FROM trashed_local_asset_entity")

    # Redact -- whitelist, not blacklist. Keep id 2002 (the Google API key,
    # needed by the import tests) and set it to the placeholder. Delete every
    # other row: id 2000 in particular holds the live bucket credential
    # (accessKey/secretKey JSON), and nothing else in this table is read by
    # src/search/import.ts or needed by any test.
    db.execute("DELETE FROM store_entity WHERE id <> 2002")
    db.execute("UPDATE store_entity SET string_value = ? WHERE id = 2002", (PLACEHOLDER_KEY,))

    db.commit()
    db.execute("VACUUM")
    db.commit()
    db.close()

    # Verify BEFORE copying to the committed destination -- checking only the
    # file we've already written there is checking it too late.
    check = sqlite3.connect(tmp)
    kept = check.execute("SELECT id, string_value FROM store_entity").fetchall()
    check.close()
    if kept != [(2002, PLACEHOLDER_KEY)]:
        sys.exit(f"store_entity is not whitelisted down to just id 2002: {kept!r}")

    # Defensive scan of the actual bytes on disk, not just the rows we meant
    # to touch -- catches anything a future schema change might miss.
    data = tmp.read_bytes()
    for needle in FORBIDDEN_SUBSTRINGS:
        if needle in data:
            sys.exit(f"defensive scan found {needle!r} in the redacted file")
    placeholder_marker = b"AIzaSyFIXTURE"
    pos = data.find(b"AIza")
    while pos != -1:
        if data[pos : pos + len(placeholder_marker)] != placeholder_marker:
            sys.exit("defensive scan found an AIza-prefixed string that is not the placeholder")
        pos = data.find(b"AIza", pos + 1)

    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(tmp, dest)

    size = Path(dest).stat().st_size
    print(f"wrote {dest} ({size} bytes); store_entity redacted to id 2002 only, defensive scan clean")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
