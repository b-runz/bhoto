import { describe, expect, test } from "bun:test";
import { matchLabels, matchNames, matchOcr, pointsInBox } from "../../src/search/local";
import type { SearchIndex } from "../../src/search/local";
import type { Item } from "../../src/types";

/** Four assets, three labels, two OCR rows, two geotagged points. */
function index(): SearchIndex {
  return {
    keys: [
      "2022/08/29/IMG_0001.jpg", // 0
      "2022/08/29/IMG_0002.jpg", // 1
      "2023/01/02/VID_0003.mp4", // 2
      "2024/06/07/IMG_0004.jpg", // 3
    ],
    // "train" -> 0,1   "strainer" -> 2   "passenger train" -> 3
    labelTerms: ["passenger train", "strainer", "train"],
    labelOffsets: new Uint32Array([0, 1, 2, 4]),
    labelPostings: new Uint32Array([3, 2, 0, 1]),
    ocrKeys: new Uint32Array([1, 3]),
    ocrText: ["danskebank icu 400548 8", "the cats sat"],
    geoKeys: new Uint32Array([0, 2]),
    geoLat: new Float64Array([56.15, 55.68]),
    geoLon: new Float64Array([10.21, 12.57]),
  };
}

describe("matchLabels", () => {
  test("matches a whole word inside a multi-word label", () => {
    expect(matchLabels(index(), "train")).toEqual(
      new Set(["2022/08/29/IMG_0001.jpg", "2022/08/29/IMG_0002.jpg", "2024/06/07/IMG_0004.jpg"]),
    );
  });

  test("does not match inside another word", () => {
    // The whole point of the space-padding trick: "train" must not hit
    // "strainer" the way a plain substring search would.
    expect(matchLabels(index(), "train").has("2023/01/02/VID_0003.mp4")).toBe(false);
  });

  test("is case- and whitespace-insensitive", () => {
    expect(matchLabels(index(), "  TRAIN ")).toEqual(matchLabels(index(), "train"));
  });

  test("matches an entire multi-word label", () => {
    expect(matchLabels(index(), "passenger train")).toEqual(new Set(["2024/06/07/IMG_0004.jpg"]));
  });

  test("returns nothing for an empty term", () => {
    expect(matchLabels(index(), "   ")).toEqual(new Set());
  });
});

describe("matchOcr", () => {
  test("matches a single token", () => {
    expect(matchOcr(index(), "danskebank")).toEqual(new Set(["2022/08/29/IMG_0002.jpg"]));
  });

  test("matches an adjacent phrase but not a scattered one", () => {
    expect(matchOcr(index(), "cats sat")).toEqual(new Set(["2024/06/07/IMG_0004.jpg"]));
    expect(matchOcr(index(), "the sat")).toEqual(new Set());
  });

  test("matches whole tokens only, like FTS5", () => {
    // "cat" is not a prefix match for "cats" under MATCH.
    expect(matchOcr(index(), "cat")).toEqual(new Set());
  });

  test("normalizes the query, so punctuation and case do not matter", () => {
    expect(matchOcr(index(), "DanskeBank!")).toEqual(new Set(["2022/08/29/IMG_0002.jpg"]));
  });

  test("survives characters that would be FTS5 query syntax", () => {
    // A lone quote is an fts5 syntax error server-side; here it is just a
    // separator, so this degrades to "no matches" rather than throwing.
    expect(() => matchOcr(index(), '"')).not.toThrow();
    expect(matchOcr(index(), '"')).toEqual(new Set());
  });

  test("returns nothing for an empty query", () => {
    expect(matchOcr(index(), "  ")).toEqual(new Set());
  });
});

describe("matchNames", () => {
  const items: Item[] = [
    { key: "2022/08/29/IMG_0001.jpg", date: "2022-08-29", bytes: 1, kind: "image" },
    { key: "2023/01/02/VID_0003.mp4", date: "2023-01-02", bytes: 1, kind: "video" },
  ];

  test("matches a case-insensitive substring of the filename", () => {
    expect(matchNames(items, "img_00")).toEqual(new Set(["2022/08/29/IMG_0001.jpg"]));
  });

  test("ignores the directory part of the key", () => {
    // "2023" is in the path, not the name, so it must not match.
    expect(matchNames(items, "2023")).toEqual(new Set());
  });

  test("returns nothing for an empty query", () => {
    expect(matchNames(items, " ")).toEqual(new Set());
  });
});

describe("pointsInBox", () => {
  test("returns the points inside, with their coordinates", () => {
    expect(pointsInBox(index(), 55.0, 56.0, 12.0, 13.0)).toEqual([
      { key: "2023/01/02/VID_0003.mp4", lat: 55.68, lon: 12.57 },
    ]);
  });

  test("is inclusive at the edges, matching SQL BETWEEN", () => {
    expect(pointsInBox(index(), 56.15, 56.15, 10.21, 10.21)).toEqual([
      { key: "2022/08/29/IMG_0001.jpg", lat: 56.15, lon: 10.21 },
    ]);
  });

  test("returns an empty array when nothing falls inside", () => {
    expect(pointsInBox(index(), 0, 1, 0, 1)).toEqual([]);
  });
});
