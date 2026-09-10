import { describe, expect, test } from "bun:test";
import { INDEX_FORMAT, matchTokens, pointsInBox } from "../../src/search/local";
import type { SearchIndex } from "../../src/search/local";

/**
 * Builds a {@link SearchIndex} from a map of key -> space-separated tokens,
 * so each test reads as data instead of hand-rolled offsets/postings arrays.
 * Geo fields are left empty; geo tests build their own index directly.
 */
function indexFrom(rows: Record<string, string>): SearchIndex {
  const keys = Object.keys(rows);
  const postingsByTerm = new Map<string, number[]>();
  keys.forEach((key, keyIndex) => {
    const tokens = rows[key]!.split(" ").filter((t) => t !== "");
    for (const token of tokens) {
      let list = postingsByTerm.get(token);
      if (!list) {
        list = [];
        postingsByTerm.set(token, list);
      }
      // Avoid duplicate postings for a term repeated within one row.
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

describe("matchTokens", () => {
  test("two-token query hits a row carrying both tokens", () => {
    // The index has no notion of columns, so a label token and an OCR token
    // both landing on one row is indistinguishable from two tokens in one
    // field -- that's the point of one inverted index over all text.
    const index = indexFrom({
      "both.jpg": "train danskebank",
      "only-train.jpg": "train",
      "only-danskebank.jpg": "danskebank",
    });
    expect(matchTokens(index, "train danskebank")).toEqual(new Set(["both.jpg"]));
  });

  test("a row carrying only one of the two tokens is excluded", () => {
    const index = indexFrom({
      "both.jpg": "train danskebank",
      "only-train.jpg": "train",
    });
    expect(matchTokens(index, "train danskebank").has("only-train.jpg")).toBe(false);
  });

  test("does not prefix-match: cat does not match a row with cats", () => {
    const index = indexFrom({ "cats.jpg": "the cats sat" });
    expect(matchTokens(index, "cat")).toEqual(new Set());
  });

  test("does not substring-match: img does not match img4821", () => {
    const index = indexFrom({ "img4821.jpg": "img4821" });
    expect(matchTokens(index, "img")).toEqual(new Set());
  });

  test("img 4821 matches a row with both tokens", () => {
    const index = indexFrom({ "img4821.jpg": "img 4821" });
    expect(matchTokens(index, "img 4821")).toEqual(new Set(["img4821.jpg"]));
  });

  test("unknown token returns an empty set", () => {
    const index = indexFrom({ "cats.jpg": "the cats sat" });
    expect(matchTokens(index, "nonexistent")).toEqual(new Set());
  });

  test("returns nothing for an empty query", () => {
    const index = indexFrom({ "cats.jpg": "the cats sat" });
    expect(matchTokens(index, "")).toEqual(new Set());
  });

  test("returns nothing for a whitespace-only query", () => {
    const index = indexFrom({ "cats.jpg": "the cats sat" });
    expect(matchTokens(index, "   ")).toEqual(new Set());
  });

  test("folds diacritics and punctuation before lookup", () => {
    const index = indexFrom({ "trip.jpg": "cafe nord" });
    expect(matchTokens(index, "Café-Nord")).toEqual(new Set(["trip.jpg"]));
  });
});

describe("pointsInBox", () => {
  function geoIndex(): SearchIndex {
    return {
      format: INDEX_FORMAT,
      keys: [
        "2022/08/29/IMG_0001.jpg", // 0
        "2023/01/02/VID_0003.mp4", // 1
      ],
      terms: [],
      offsets: new Uint32Array([0]),
      postings: new Uint32Array(0),
      geoKeys: new Uint32Array([0, 1]),
      geoLat: new Float64Array([56.15, 55.68]),
      geoLon: new Float64Array([10.21, 12.57]),
    };
  }

  test("returns the points inside, with their coordinates", () => {
    expect(pointsInBox(geoIndex(), 55.0, 56.0, 12.0, 13.0)).toEqual([
      { key: "2023/01/02/VID_0003.mp4", lat: 55.68, lon: 12.57 },
    ]);
  });

  test("is inclusive at the edges, matching SQL BETWEEN", () => {
    expect(pointsInBox(geoIndex(), 56.15, 56.15, 10.21, 10.21)).toEqual([
      { key: "2022/08/29/IMG_0001.jpg", lat: 56.15, lon: 10.21 },
    ]);
  });

  test("returns an empty array when nothing falls inside", () => {
    expect(pointsInBox(geoIndex(), 0, 1, 0, 1)).toEqual([]);
  });
});
