import { describe, expect, test } from "bun:test";
import initSqlJs from "sql.js";
import type { SqlDatabase } from "../../src/search/sqljs";

async function open(): Promise<SqlDatabase> {
  const SQL = await initSqlJs();
  const bytes = new Uint8Array(await Bun.file("test/fixtures/search.db").arrayBuffer());
  return new SQL.Database(bytes);
}

/**
 * Proves the vendored build can read this project's actual schema before any
 * extraction logic depends on it. The fixture is not a plain set of tables:
 * `tools/make_search_fixture.py` creates `gallery_fts`, an FTS5 virtual
 * table, and the three triggers that keep it in sync, exactly as the phone
 * does. If sql.js were built without FTS5 the schema would still parse, but
 * a build that chokes on the vtab or the triggers would fail here rather
 * than inside the Worker.
 */
describe("sql.js against the fixture", () => {
  test("opens a database carrying an FTS5 virtual table and its triggers", async () => {
    const db = await open();

    // The count the script documents: six renderable rows plus the
    // local-only and archived ones.
    const count = db.prepare("SELECT COUNT(*) FROM gallery_asset");
    expect(count.step()).toBe(true);
    expect(Number(count.get()[0])).toBe(8);
    count.free();

    // Both halves of the FTS machinery are really in the file.
    const objects = db.prepare(
      "SELECT type FROM sqlite_master WHERE name = 'gallery_fts'" +
        " OR name LIKE 'gallery_fts_a%' ORDER BY name",
    );
    const kinds: string[] = [];
    while (objects.step()) kinds.push(String(objects.get()[0]));
    objects.free();
    expect(kinds).toEqual(["table", "trigger", "trigger", "trigger"]);

    db.close();
  });

  test("reads a 3 KB embedding blob out of an overflow page", async () => {
    const db = await open();
    const blob = db.prepare("SELECT embedding FROM label_embedding LIMIT 1");
    expect(blob.step()).toBe(true);
    const value = blob.get()[0];
    expect(value).toBeInstanceOf(Uint8Array);
    expect((value as Uint8Array).length).toBe(3072);
    blob.free();
    db.close();
  });

  test("run() executes a statement that returns no rows", async () => {
    const db = await open();
    db.run("DROP TABLE store_entity");
    const gone = db.prepare("SELECT name FROM sqlite_master WHERE name = 'store_entity'");
    expect(gone.step()).toBe(false);
    gone.free();
    db.close();
  });

  test("the committed fixture carries no real API key", async () => {
    const db = await open();
    const stmt = db.prepare("SELECT string_value FROM store_entity WHERE id = 2002");
    expect(stmt.step()).toBe(true);
    expect(String(stmt.get()[0])).toContain("FIXTURE");
    stmt.free();
    db.close();
  });
});
