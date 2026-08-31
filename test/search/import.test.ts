import { describe, expect, test } from "bun:test";
import initSqlJs from "sql.js";
import { buildIndex } from "../../src/search/import";
import { matchLabels, matchOcr } from "../../src/search/local";
import type { ImportResult } from "../../src/search/import";

let cached: ImportResult | undefined;

async function imported(): Promise<ImportResult> {
  if (cached !== undefined) return cached;
  const SQL = await initSqlJs();
  const bytes = new Uint8Array(await Bun.file("test/fixtures/search.db").arrayBuffer());
  const db = new SQL.Database(bytes);
  cached = buildIndex(db);
  db.close();
  return cached;
}

describe("buildIndex", () => {
  test("keys are S3 keys and exclude the soft-deleted asset", async () => {
    const { index } = await imported();
    // The fixture holds 8 assets, one of them soft-deleted.
    expect(index.keys.length).toBe(7);
    for (const key of index.keys) expect(key).toMatch(/^\d{4}\/\d{2}\/\d{2}\//);
    expect(new Set(index.keys).size).toBe(index.keys.length);
  });

  test("posting lists are well formed", async () => {
    const { index } = await imported();
    expect(index.labelOffsets.length).toBe(index.labelTerms.length + 1);
    expect(index.labelOffsets[0]).toBe(0);
    expect(index.labelOffsets[index.labelTerms.length]).toBe(index.labelPostings.length);
    for (const posting of index.labelPostings) {
      expect(posting).toBeLessThan(index.keys.length);
    }
  });

  test("label terms are lowercased, unique and sorted", async () => {
    const { index } = await imported();
    const sorted = [...index.labelTerms].sort();
    expect(index.labelTerms).toEqual(sorted);
    expect(new Set(index.labelTerms).size).toBe(index.labelTerms.length);
    for (const term of index.labelTerms) expect(term).toBe(term.toLowerCase());
  });

  test("drops labels that belong only to a phone-local asset", async () => {
    const { index } = await imported();
    expect(index.labelTerms).not.toContain("local only label");
  });

  test("OCR rows are normalized and joined to live remote assets only", async () => {
    const { index } = await imported();
    expect(index.ocrKeys.length).toBe(index.ocrText.length);
    for (const text of index.ocrText) {
      // normalize() output: lowercase, single-spaced, trimmed.
      expect(text).toBe(text.toLowerCase());
      expect(text).not.toMatch(/\s{2,}|^\s|\s$/);
    }
    // asset_fts_content.c0 is not always an S3 key -- the fixture carries a
    // local numeric one, and the join is what removes it.
    expect(matchOcr(index, "local only receipt")).toEqual(new Set());
  });

  test("geo rows carry finite coordinates and are parallel", async () => {
    const { index } = await imported();
    expect(index.geoLat.length).toBe(index.geoKeys.length);
    expect(index.geoLon.length).toBe(index.geoKeys.length);
    for (const lat of index.geoLat) expect(Number.isFinite(lat)).toBe(true);
    for (const lon of index.geoLon) expect(Number.isFinite(lon)).toBe(true);
  });

  test("embeddings are 768-dimension and match the pinned model", async () => {
    const { embeddings } = await imported();
    expect(embeddings.dims).toBe(768);
    expect(embeddings.model).toBe("gemini-embedding-001");
    expect(embeddings.vectors.length).toBe(embeddings.labels.length * 768);
  });

  test("embeddings are restricted to labels that survive the join", async () => {
    const { index, embeddings } = await imported();
    const live = new Set(index.labelTerms);
    for (const label of embeddings.labels) expect(live.has(label)).toBe(true);
    // The fixture plants one whose label no live asset carries.
    expect(embeddings.labels).not.toContain("dead end label");
  });

  test("reads the API key out of store_entity", async () => {
    const { apiKey } = await imported();
    expect(apiKey).toContain("FIXTURE");
  });

  test("the built index answers a real label search", async () => {
    const { index } = await imported();
    const term = index.labelTerms[0]!;
    expect(matchLabels(index, term).size).toBeGreaterThan(0);
  });
});
