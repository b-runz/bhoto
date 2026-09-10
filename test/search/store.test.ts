import { describe, expect, test } from "bun:test";
import { isCurrentIndex } from "../../src/search/store";
import { INDEX_FORMAT } from "../../src/search/local";

/**
 * Only the pure guard is tested here. Everything else in `store.ts` goes
 * through IndexedDB, which Bun's runtime does not provide, so it is exercised
 * by hand like the rest of the storage path.
 */
function current(): unknown {
  return {
    format: INDEX_FORMAT,
    keys: ["a.jpg"],
    terms: ["train"],
    offsets: new Uint32Array([0, 1]),
    postings: new Uint32Array([0]),
    geoKeys: new Uint32Array([0]),
    geoLat: new Float64Array([56.15]),
    geoLon: new Float64Array([10.21]),
  };
}

describe("isCurrentIndex", () => {
  test("accepts an index at the current format", () => {
    expect(isCurrentIndex(current())).toBe(true);
  });

  test("accepts an index with no geotagged rows at all", () => {
    const empty = {
      ...(current() as Record<string, unknown>),
      geoKeys: new Uint32Array(0),
      geoLat: new Float64Array(0),
      geoLon: new Float64Array(0),
    };
    expect(isCurrentIndex(empty)).toBe(true);
  });

  test("rejects the pre-migration record, which has no format and label columns", () => {
    // What a viewer that ran before this migration left in IndexedDB.
    const legacy = {
      keys: ["a.jpg"],
      labelTerms: ["train"],
      labelOffsets: new Uint32Array([0, 1]),
      labelPostings: new Uint32Array([0]),
      ocrKeys: new Uint32Array(0),
      ocrText: [],
      geoKeys: new Uint32Array(0),
      geoLat: new Float64Array(0),
      geoLon: new Float64Array(0),
    };
    expect(isCurrentIndex(legacy)).toBe(false);
  });

  test("rejects a record carrying another format number", () => {
    expect(isCurrentIndex({ ...(current() as Record<string, unknown>), format: 3 })).toBe(false);
    expect(isCurrentIndex({ ...(current() as Record<string, unknown>), format: 1 })).toBe(false);
    expect(isCurrentIndex({ ...(current() as Record<string, unknown>), format: "2" })).toBe(false);
  });

  test("rejects null and undefined", () => {
    expect(isCurrentIndex(null)).toBe(false);
    expect(isCurrentIndex(undefined)).toBe(false);
  });

  test("rejects a value that is not an object", () => {
    expect(isCurrentIndex("index")).toBe(false);
    expect(isCurrentIndex(INDEX_FORMAT)).toBe(false);
  });

  test("rejects a right-format record whose typed arrays came back as plain arrays", () => {
    // A hand-written or JSON-round-tripped record. Structured clone keeps
    // typed arrays typed, so anything else is not something search can run
    // against -- `postings[p]` would still index, but `matchTokens` relies on
    // the numeric arrays, and a JSON round trip is a sign of a foreign writer.
    const plain = { ...(current() as Record<string, unknown>), postings: [0] };
    expect(isCurrentIndex(plain)).toBe(false);
  });

  test("rejects a right-format record missing a field", () => {
    for (const field of ["keys", "terms", "offsets", "postings", "geoKeys", "geoLat", "geoLon"]) {
      const partial = { ...(current() as Record<string, unknown>) };
      delete partial[field];
      expect(isCurrentIndex(partial)).toBe(false);
    }
  });

  test("rejects a record whose float columns are integer arrays", () => {
    const wrong = { ...(current() as Record<string, unknown>), geoLat: new Uint32Array([56]) };
    expect(isCurrentIndex(wrong)).toBe(false);
  });
});
