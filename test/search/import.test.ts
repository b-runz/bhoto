import { describe, expect, test } from "bun:test";
import initSqlJs from "sql.js";
import { buildIndex } from "../../src/search/import";
import { INDEX_FORMAT, matchTokens } from "../../src/search/local";
import type { SearchIndex } from "../../src/search/local";
import type { ImportResult } from "../../src/search/import";
import type { SqlDatabase } from "../../src/search/sqljs";
import { companionsFor, dimensionsFor } from "../../src/assets";

/**
 * Every expectation below is drawn from the fixture documented in
 * `tools/make_search_fixture.py`: six renderable assets, one local-only row
 * (`remote_key = ''`) and one archived row (`visibility = 2`), both of which
 * also carry `has_location = 1` so that geo has to honour the renderable
 * filter and not just the location flag.
 */
const KEY_TRAIN_PLATFORM = "2024/03/14/IMG_4821.jpg";
const KEY_TRAIN_CAFE = "2024/03/14/IMG_4822.jpg";
const KEY_DOG_PORTRAIT = "2024/05/02/DSC_0007.JPG";
const KEY_SUNSET_PUNCTUATION = "2024/07/19/PXL_20240719_101530123.jpg";
const KEY_SAILBOAT_AERO = "2024/08/05/IMG_5099.jpg";
const KEY_BICYCLE_BENCH = "2024/11/23/IMG_6410.jpg";
/** In the bucket, but archived: never searchable, always laid out. */
const KEY_ARCHIVED = "2024/12/24/IMG_7777.jpg";

/** The six renderable keys, in `ORDER BY remote_key` order. */
const RENDERABLE_KEYS = [
  KEY_TRAIN_PLATFORM,
  KEY_TRAIN_CAFE,
  KEY_DOG_PORTRAIT,
  KEY_SUNSET_PUNCTUATION,
  KEY_SAILBOAT_AERO,
  KEY_BICYCLE_BENCH,
];

/** Every token the six renderable rows carry, across all four columns. */
const ALL_TERMS = [
  "00", "0007", "05", "101530123", "14", "15", "20240719", "3", "45", "4821",
  "4822", "5099", "6410", "afgang", "apple", "bench", "bicycle", "cafe",
  "creme", "cykelparkering", "d750", "dog", "dsc", "forbudt", "fujifilm",
  "img", "iphone", "jpg", "kr", "nikon", "passenger", "perron", "pro", "pxl",
  "sailboat", "sunset", "t5", "til", "train", "velkommen", "x", "ærø",
];

/**
 * Tokens carried only by the two excluded rows. Their presence in `terms`
 * would mean an excluded row leaked into the index.
 */
const EXCLUDED_ONLY_TERMS = [
  "9001", "local", "only", "sign", "kun", "pa", "telefonen",
  "7777", "christmas", "tree", "canon", "eos", "r6", "glædelig", "jul",
];

async function open(): Promise<SqlDatabase> {
  const SQL = await initSqlJs();
  const bytes = new Uint8Array(await Bun.file("test/fixtures/search.db").arrayBuffer());
  return new SQL.Database(bytes);
}

let cached: ImportResult | undefined;

async function imported(): Promise<ImportResult> {
  if (cached !== undefined) return cached;
  const db = await open();
  cached = buildIndex(db);
  db.close();
  return cached;
}

/** The keys posted under [term], read straight out of `offsets`/`postings`. */
function keysFor(index: SearchIndex, term: string): string[] {
  const t = index.terms.indexOf(term);
  if (t === -1) return [];
  const out: string[] = [];
  for (let p = index.offsets[t]!; p < index.offsets[t + 1]!; p++) {
    out.push(index.keys[index.postings[p]!]!);
  }
  return out;
}

/** Every term whose posting list contains [key]. */
function termsOf(index: SearchIndex, key: string): string[] {
  const at = index.keys.indexOf(key);
  const out: string[] = [];
  for (let t = 0; t < index.terms.length; t++) {
    for (let p = index.offsets[t]!; p < index.offsets[t + 1]!; p++) {
      if (index.postings[p] === at) {
        out.push(index.terms[t]!);
        break;
      }
    }
  }
  return out;
}

describe("buildIndex", () => {
  test("stamps the current index format", async () => {
    const { index } = await imported();
    expect(index.format).toBe(INDEX_FORMAT);
  });

  test("keys are the renderable remote keys, sorted", async () => {
    const { index } = await imported();
    expect(index.keys).toEqual(RENDERABLE_KEYS);
  });

  test("keys exclude the local-only and archived rows", async () => {
    const { index } = await imported();
    // The local-only row has remote_key = '', the archived row visibility 2.
    expect(index.keys).not.toContain("");
    expect(index.keys).not.toContain("2024/12/24/IMG_7777.jpg");
    for (const term of EXCLUDED_ONLY_TERMS) expect(index.terms).not.toContain(term);
  });

  test("terms are the union over name, label, camera and OCR text", async () => {
    const { index } = await imported();
    expect(index.terms).toEqual(ALL_TERMS);
  });

  test("a filename token resolves to its asset", async () => {
    const { index } = await imported();
    expect(keysFor(index, "4821")).toEqual([KEY_TRAIN_PLATFORM]);
    expect(keysFor(index, "img")).toEqual([
      KEY_TRAIN_PLATFORM,
      KEY_TRAIN_CAFE,
      KEY_SAILBOAT_AERO,
      KEY_BICYCLE_BENCH,
    ]);
    expect(keysFor(index, "jpg")).toEqual(RENDERABLE_KEYS);
  });

  test("a label token resolves to every asset carrying the label", async () => {
    const { index } = await imported();
    expect(keysFor(index, "train")).toEqual([KEY_TRAIN_PLATFORM, KEY_TRAIN_CAFE]);
    expect(keysFor(index, "dog")).toEqual([KEY_TRAIN_PLATFORM, KEY_DOG_PORTRAIT]);
  });

  test("a camera token resolves to its asset", async () => {
    const { index } = await imported();
    expect(keysFor(index, "fujifilm")).toEqual([KEY_TRAIN_PLATFORM]);
    expect(keysFor(index, "nikon")).toEqual([KEY_DOG_PORTRAIT]);
    expect(keysFor(index, "iphone")).toEqual([KEY_BICYCLE_BENCH]);
  });

  test("an OCR token resolves to its asset", async () => {
    const { index } = await imported();
    expect(keysFor(index, "perron")).toEqual([KEY_TRAIN_PLATFORM]);
    expect(keysFor(index, "cykelparkering")).toEqual([KEY_BICYCLE_BENCH]);
    // NFD decomposes é and è, so the OCR accents come off in the index.
    expect(keysFor(index, "cafe")).toEqual([KEY_TRAIN_CAFE]);
    expect(keysFor(index, "creme")).toEqual([KEY_TRAIN_CAFE]);
  });

  test("a multi-word label becomes two separate terms", async () => {
    const { index } = await imported();
    // label_text `bicycle bench` is one column value, two tokens.
    expect(keysFor(index, "bicycle")).toEqual([KEY_BICYCLE_BENCH]);
    expect(keysFor(index, "bench")).toEqual([KEY_BICYCLE_BENCH]);
    expect(index.terms).not.toContain("bicycle bench");
    expect(index.terms).not.toContain("passenger train");
  });

  test("punctuation-only OCR contributes no terms", async () => {
    const { index } = await imported();
    // `--- *** !!! ...` normalizes to the empty string, so this row's terms
    // are exactly what its name and label columns carry.
    expect(termsOf(index, KEY_SUNSET_PUNCTUATION)).toEqual([
      "101530123",
      "20240719",
      "jpg",
      "pxl",
      "sunset",
    ]);
  });

  test("indexes ærø as written and never as aero", async () => {
    const { index } = await imported();
    // normalize() emulates unicode61, which leaves æ and ø alone; the query
    // side folds `Ærø` to `aero`, so it cannot match. Inherited from the
    // phone, documented rather than fixed.
    expect(index.terms).toContain("ærø");
    expect(index.terms).not.toContain("aero");
    expect(keysFor(index, "ærø")).toEqual([KEY_SAILBOAT_AERO]);
    expect(matchTokens(index, "Ærø")).toEqual(new Set());
  });

  test("offsets span the postings and rise monotonically", async () => {
    const { index } = await imported();
    expect(index.offsets.length).toBe(index.terms.length + 1);
    expect(index.offsets[0]).toBe(0);
    expect(index.offsets[index.terms.length]).toBe(index.postings.length);
    for (let t = 0; t < index.terms.length; t++) {
      expect(index.offsets[t + 1]!).toBeGreaterThan(index.offsets[t]!);
    }
  });

  test("posting lists are ascending, unique and in range", async () => {
    const { index } = await imported();
    for (let t = 0; t < index.terms.length; t++) {
      const start = index.offsets[t]!;
      const end = index.offsets[t + 1]!;
      for (let p = start; p < end; p++) {
        expect(index.postings[p]!).toBeLessThan(index.keys.length);
        if (p > start) expect(index.postings[p]!).toBeGreaterThan(index.postings[p - 1]!);
      }
    }
  });

  test("terms are sorted by code unit and unique", async () => {
    const { index } = await imported();
    expect(index.terms).toEqual([...index.terms].sort());
    expect(new Set(index.terms).size).toBe(index.terms.length);
  });

  test("geo carries the located renderable rows only", async () => {
    const { index } = await imported();
    expect(index.geoLat.length).toBe(index.geoKeys.length);
    expect(index.geoLon.length).toBe(index.geoKeys.length);

    const points = new Map<string, [number, number]>();
    for (let i = 0; i < index.geoKeys.length; i++) {
      points.set(index.keys[index.geoKeys[i]!]!, [index.geoLat[i]!, index.geoLon[i]!]);
    }
    // Five of the six: the sunset row has has_location = 0 and its columns
    // sit at their 0.0 defaults. The two excluded rows carry
    // has_location = 1 and must still be absent.
    expect(points).toEqual(
      new Map<string, [number, number]>([
        [KEY_TRAIN_PLATFORM, [55.6761, 12.5683]],
        [KEY_TRAIN_CAFE, [48.8584, 2.2945]],
        [KEY_DOG_PORTRAIT, [51.5072, -0.1276]],
        [KEY_SAILBOAT_AERO, [54.8878, 10.4094]],
        [KEY_BICYCLE_BENCH, [35.6595, 139.7005]],
      ]),
    );
    expect(points.has(KEY_SUNSET_PUNCTUATION)).toBe(false);
  });

  test("embeddings keep the live labels of the pinned model only", async () => {
    const { embeddings } = await imported();
    expect([...embeddings.labels].sort()).toEqual([
      "bicycle",
      "dog",
      "passenger train",
      "sailboat",
      "sunset",
    ]);
    // `local only sign` is the right model but belongs to the local-only
    // asset; `bench` is a live label under `other-model`.
    expect(embeddings.labels).not.toContain("local only sign");
    expect(embeddings.labels).not.toContain("bench");
  });

  test("embeddings are 768 wide and packed", async () => {
    const { embeddings } = await imported();
    expect(embeddings.dims).toBe(768);
    expect(embeddings.model).toBe("gemini-embedding-001");
    expect(embeddings.vectors.length).toBe(embeddings.labels.length * 768);

    // The blob is copied out, not viewed, so the float32 values have to
    // survive whatever byte offset sql.js handed back. `passenger train` is
    // the fixture's one-hot-ish vector: v[0] = 1.0, every other 0.001.
    const at = embeddings.labels.indexOf("passenger train");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(embeddings.vectors[at * 768]).toBe(1);
    expect(embeddings.vectors[at * 768 + 1]!).toBeCloseTo(0.001, 6);
    expect(embeddings.vectors[at * 768 + 767]!).toBeCloseTo(0.001, 6);
  });

  test("reads the API key out of store_entity", async () => {
    const { apiKey } = await imported();
    expect(apiKey).toBe('{"apiKey":"AIzaSyFIXTURE-not-a-real-key-000000000000"}');
  });

  test("returns a null API key when store_entity is absent", async () => {
    const db = await open();
    db.run("DROP TABLE store_entity");
    const result = buildIndex(db);
    db.close();

    const expected = await imported();
    expect(result.apiKey).toBeNull();
    expect(result.index.keys).toEqual(expected.index.keys);
    expect(result.index.terms).toEqual(expected.index.terms);
    expect([...result.index.offsets]).toEqual([...expected.index.offsets]);
    expect([...result.index.postings]).toEqual([...expected.index.postings]);
    expect([...result.index.geoKeys]).toEqual([...expected.index.geoKeys]);
    expect(result.embeddings.labels).toEqual(expected.embeddings.labels);
  });

  test("the asset table lists every remote key whatever its visibility, sorted", async () => {
    const { assets } = await imported();
    // The archived row is in the bucket, so the grid shows it and needs its
    // dimensions; the local-only row has no object and is left out.
    expect(assets.keys).toEqual([...RENDERABLE_KEYS, KEY_ARCHIVED]);
    expect(assets.width.length).toBe(assets.keys.length);
    expect(assets.height.length).toBe(assets.keys.length);
    expect(assets.companions.length).toBe(assets.keys.length);
  });

  test("the asset table carries the phone's display-oriented dimensions", async () => {
    const { assets } = await imported();
    expect(dimensionsFor(assets, KEY_TRAIN_PLATFORM)).toEqual({ w: 4032, h: 3024 });
    expect(dimensionsFor(assets, KEY_BICYCLE_BENCH)).toEqual({ w: 4284, h: 5712 });
    expect(dimensionsFor(assets, KEY_ARCHIVED)).toEqual({ w: 5472, h: 3648 });
    // The sunset row was recorded before the phone knew its size.
    expect(dimensionsFor(assets, KEY_SUNSET_PUNCTUATION)).toBeUndefined();
  });

  test("the asset table names each row's companion objects, empty keys dropped", async () => {
    const { assets } = await imported();
    expect(companionsFor(assets, KEY_TRAIN_PLATFORM)).toEqual([
      "2024/03/14/thumb/IMG_4821.jpg",
      "2024/03/14/IMG_4821.MOV",
      ".faces/2024/03/14/IMG_4821.jpg.json.gz",
    ]);
    expect(companionsFor(assets, KEY_TRAIN_CAFE)).toEqual(["2024/03/14/thumb/IMG_4822.jpg"]);
    // No thumb_key, no live photo, no sidecar: nothing beyond the original.
    expect(companionsFor(assets, KEY_SUNSET_PUNCTUATION)).toEqual([]);
  });

  test("the built index answers a real multi-token search", async () => {
    const { index } = await imported();
    expect(matchTokens(index, "passenger train")).toEqual(
      new Set([KEY_TRAIN_PLATFORM, KEY_TRAIN_CAFE]),
    );
    expect(matchTokens(index, "train dog")).toEqual(new Set([KEY_TRAIN_PLATFORM]));
    expect(matchTokens(index, "IMG_4821")).toEqual(new Set([KEY_TRAIN_PLATFORM]));
  });
});
