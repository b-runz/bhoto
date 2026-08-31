import { describe, expect, test } from "bun:test";
import initSqlJs from "sql.js";

/**
 * Proves the vendored build can read this project's actual schema before any
 * extraction logic depends on it: WITHOUT ROWID tables (stored as index
 * b-trees), STRICT tables, and 3 KB blobs that spill into overflow pages.
 */
describe("sql.js against the fixture", () => {
  test("opens the fixture and reads all three awkward shapes", async () => {
    const SQL = await initSqlJs();
    const bytes = new Uint8Array(await Bun.file("test/fixtures/search.db").arrayBuffer());
    const db = new SQL.Database(bytes);

    // WITHOUT ROWID + STRICT.
    const assets = db.prepare("SELECT id FROM remote_asset_entity");
    let assetCount = 0;
    while (assets.step()) assetCount++;
    assets.free();
    expect(assetCount).toBeGreaterThan(0);

    // A blob big enough to overflow a 4 KB page.
    const blob = db.prepare("SELECT embedding FROM label_embedding_entity LIMIT 1");
    expect(blob.step()).toBe(true);
    const value = blob.get()[0];
    expect(value).toBeInstanceOf(Uint8Array);
    expect((value as Uint8Array).length).toBe(3072);
    blob.free();

    // The FTS shadow table, read as an ordinary table -- no FTS5 needed.
    const ocr = db.prepare("SELECT c0, c1 FROM asset_fts_content LIMIT 1");
    expect(ocr.step()).toBe(true);
    ocr.free();

    db.close();
  });

  test("the committed fixture carries no real API key", async () => {
    const SQL = await initSqlJs();
    const bytes = new Uint8Array(await Bun.file("test/fixtures/search.db").arrayBuffer());
    const db = new SQL.Database(bytes);
    const stmt = db.prepare("SELECT string_value FROM store_entity WHERE id = 2002");
    expect(stmt.step()).toBe(true);
    expect(String(stmt.get()[0])).toContain("FIXTURE");
    stmt.free();
    db.close();
  });
});
