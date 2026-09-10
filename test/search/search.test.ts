import { describe, expect, test } from "bun:test";
import { runSearch, suggestFor } from "../../src/search/search";
import { INDEX_FORMAT } from "../../src/search/local";
import type { SearchDeps } from "../../src/search/search";
import type { SearchIndex } from "../../src/search/local";
import type { NominatimPlace } from "../../src/search/nominatim";
import type { Embeddings } from "../../src/search/suggest";
import type { Item } from "../../src/types";

const KEYS = [
  "2022/08/29/IMG_0001.jpg", // label "train", geotagged in the box
  "2022/08/29/IMG_0002.jpg", // OCR "danskebank"
  "2023/01/02/VID_0003.mp4", // label "tog rejse" only
  "2024/06/07/IMG_0004.jpg", // in the index, gone from the manifest
];

/**
 * Builds a {@link SearchIndex} from a map of key -> space-separated tokens.
 * Same shape as the helper in `local.test.ts`: one inverted index over every
 * column, so a test row's tokens are simply whatever text that asset carried,
 * whether it came from a label, from OCR or from the filename.
 */
function indexFrom(rows: Record<string, string>): SearchIndex {
  const keys = Object.keys(rows);
  const postingsByTerm = new Map<string, number[]>();
  keys.forEach((key, keyIndex) => {
    for (const token of rows[key]!.split(" ").filter((t) => t !== "")) {
      let list = postingsByTerm.get(token);
      if (!list) {
        list = [];
        postingsByTerm.set(token, list);
      }
      if (list[list.length - 1] !== keyIndex) list.push(keyIndex);
    }
  });

  const terms = [...postingsByTerm.keys()].sort();
  const offsets = new Uint32Array(terms.length + 1);
  const postings: number[] = [];
  terms.forEach((term, t) => {
    offsets[t] = postings.length;
    for (const keyIndex of postingsByTerm.get(term)!) postings.push(keyIndex);
  });
  offsets[terms.length] = postings.length;

  return {
    format: INDEX_FORMAT,
    keys,
    terms,
    offsets,
    postings: new Uint32Array(postings),
    geoKeys: new Uint32Array(0),
    geoLat: new Float64Array(0),
    geoLon: new Float64Array(0),
  };
}

/**
 * The stock index. Tokens are the folded form of each asset's label, OCR text
 * and filename, exactly as the import would have written them: `IMG_0001.jpg`
 * folds to `img 0001 jpg`, so the filename is three ordinary tokens.
 */
function index(): SearchIndex {
  const built = indexFrom({
    [KEYS[0]!]: "train img 0001 jpg",
    [KEYS[1]!]: "danskebank icu img 0002 jpg",
    [KEYS[2]!]: "tog rejse vid 0003 mp4",
    [KEYS[3]!]: "orphan img 0004 jpg",
  });
  // Only IMG_0001 is geotagged, inside the Aarhus box below.
  built.geoKeys = new Uint32Array([0]);
  built.geoLat = new Float64Array([56.15]);
  built.geoLon = new Float64Array([10.21]);
  return built;
}

/** The manifest deliberately lacks IMG_0004: it is in the index but gone. */
const items: Item[] = KEYS.slice(0, 3).map((key) => ({
  key,
  date: key.slice(0, 10).replace(/\//g, "-"),
  bytes: 1,
  kind: key.endsWith(".mp4") ? "video" : "image",
}));

const aarhus: NominatimPlace = {
  displayName: "Aarhus, Danmark",
  name: "Aarhus",
  nameEn: "Aarhus",
  nameDa: "Aarhus",
  country: "Denmark",
  lat: 56.15,
  lon: 10.21,
  boundingBox: [56.0, 56.3, 10.0, 10.4],
  geojson: null,
};

function deps(over: Partial<SearchDeps> = {}): SearchDeps {
  return {
    index: index(),
    items,
    translate: async () => null,
    places: async () => [],
    embed: async () => null,
    embeddings: async () => null,
    timeoutMs: 50,
    ...over,
  };
}

describe("runSearch", () => {
  test("matches a token from any column through the one index", async () => {
    expect(await runSearch("train", deps())).toEqual(new Set([KEYS[0]!]));
    expect(await runSearch("danskebank", deps())).toEqual(new Set([KEYS[1]!]));
    // The filename pass is gone: `VID_0003` folds to `vid 0003` and both
    // tokens are in the index, so the AND still lands on the video.
    expect(await runSearch("VID_0003", deps())).toEqual(new Set([KEYS[2]!]));
  });

  test("requires every token of the query, as FTS5 does", async () => {
    expect(await runSearch("train danskebank", deps())).toEqual(new Set());
  });

  test("returns nothing for a token no asset carries", async () => {
    expect(await runSearch("submarine", deps())).toEqual(new Set());
  });

  test("uses the translation to reach a label in the other language", async () => {
    const translate = async (q: string) => (q === "train" ? "tog" : null);
    // "train" hits the English label directly AND, once translated, the
    // Danish one. Both are kept.
    expect(await runSearch("train", deps({ translate }))).toEqual(
      new Set([KEYS[0]!, KEYS[2]!]),
    );
  });

  test("ignores a translation identical to the query", async () => {
    let calls = 0;
    const translate = async (q: string) => {
      calls++;
      return q;
    };
    await runSearch("train", deps({ translate }));
    expect(calls).toBe(1);
  });

  test("ignores an empty translation", async () => {
    expect(await runSearch("train", deps({ translate: async () => "" }))).toEqual(
      new Set([KEYS[0]!]),
    );
  });

  test("adds geotagged assets for an exactly-named place", async () => {
    const found = await runSearch("Aarhus", deps({ places: async () => [aarhus] }));
    expect(found).toEqual(new Set([KEYS[0]!]));
  });

  test("rejects a place the query only prefix-matches", async () => {
    const catalunya: NominatimPlace = { ...aarhus, name: "Catalunya", nameEn: "Catalonia", nameDa: null };
    expect(await runSearch("cat", deps({ places: async () => [catalunya] }))).toEqual(new Set());
  });

  test("does not call Nominatim for a query under three characters", async () => {
    let called = false;
    const places = async () => {
      called = true;
      return [aarhus];
    };
    await runSearch("aa", deps({ places }));
    expect(called).toBe(false);
  });

  test("excludes a point the polygon rejects even though the box accepts it", async () => {
    const wide: NominatimPlace = {
      ...aarhus,
      name: "Wideland",
      nameEn: "Wideland",
      nameDa: null,
      boundingBox: [-90, 90, -180, 180],
      geojson: {
        type: "Polygon",
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      },
    };
    expect(await runSearch("Wideland", deps({ places: async () => [wide] }))).toEqual(new Set());
  });

  test("returns local results when the place lookup hangs past the timeout", async () => {
    const places = () => new Promise<NominatimPlace[]>(() => {});
    const found = await runSearch("train", deps({ places }));
    expect(found).toEqual(new Set([KEYS[0]!]));
  });

  test("returns local results when the translation hangs past the timeout", async () => {
    const translate = () => new Promise<string | null>(() => {});
    expect(await runSearch("train", deps({ translate }))).toEqual(new Set([KEYS[0]!]));
  });

  test("drops keys the manifest no longer holds", async () => {
    // IMG_0004 is in the index's key table but not in the bucket listing.
    expect(await runSearch("orphan", deps())).toEqual(new Set());
  });

  test("returns nothing for an empty query without touching the network", async () => {
    let called = false;
    const places = async () => {
      called = true;
      return [];
    };
    expect(await runSearch("   ", deps({ places }))).toEqual(new Set());
    expect(called).toBe(false);
  });
});

describe("suggestFor", () => {
  const embeddings: Embeddings = {
    labels: ["train", "tog rejse"],
    vectors: new Float32Array([1, 0, 0, 0, 1, 0]),
    dims: 3,
    model: "gemini-embedding-001",
  };

  test("offers labels the embedding places close to the query", async () => {
    const found = await suggestFor(
      "trian",
      deps({ embed: async () => [1, 0, 0], embeddings: async () => embeddings }),
    );
    expect(found).toEqual([{ display: "train", query: "train" }]);
  });

  test("offers places, qualified by country, resubmitting the bare name", async () => {
    const found = await suggestFor(
      "arhus",
      deps({ places: async () => [aarhus] }),
    );
    expect(found).toEqual([{ display: "Aarhus (Denmark)", query: "Aarhus" }]);
  });

  test("drops a place whose name is what the user already typed", async () => {
    // Resubmitting it would reproduce the same empty result, so the chip
    // provably cannot change anything.
    expect(await suggestFor("Aarhus", deps({ places: async () => [aarhus] }))).toEqual([]);
  });

  test("does not let a case-only duplicate name consume a suggestion slot", async () => {
    // Set.prototype.add always returns the Set, which is truthy, so a naive
    // `!seen.add(lowered)` guard never trips and a duplicate leaks through.
    // A bare two-candidate case ("Berlin" / "BERLIN") isn't enough to catch
    // this as a regression: mergeSuggestions does its own correct
    // case-insensitive dedup on the final list and collapses the pair back
    // down to one chip either way. The bug is only observable through
    // PLACE_SUGGESTION_LIMIT: an uncounted duplicate crowds out a later,
    // genuinely distinct place before mergeSuggestions ever sees it. So this
    // sends six candidates -- a case-only duplicate pair plus four more
    // distinct places -- and checks that the fifth distinct place ("Madrid")
    // survives instead of being displaced by the duplicate.
    const named = (name: string, country: string): NominatimPlace => ({
      ...aarhus,
      name,
      nameEn: name,
      nameDa: null,
      country,
    });
    const candidates = [
      named("Berlin", "Germany"),
      named("BERLIN", "Germany"), // case-only duplicate of the above
      named("Paris", "France"),
      named("London", "United Kingdom"),
      named("Rome", "Italy"),
      named("Madrid", "Spain"),
    ];
    const found = await suggestFor("somewhere", deps({ places: async () => candidates }));
    expect(found.map((s) => s.query)).toEqual(["Berlin", "Paris", "London", "Rome", "Madrid"]);
  });

  test("returns nothing when there is no API key path and no place match", async () => {
    expect(await suggestFor("zzz", deps())).toEqual([]);
  });

  test("returns nothing for a query under three characters", async () => {
    expect(await suggestFor("aa", deps({ places: async () => [aarhus] }))).toEqual([]);
  });

  test("survives the embedding call failing", async () => {
    const found = await suggestFor(
      "trian",
      deps({ embed: async () => null, embeddings: async () => embeddings, places: async () => [aarhus] }),
    );
    expect(found).toEqual([{ display: "Aarhus (Denmark)", query: "Aarhus" }]);
  });
});
