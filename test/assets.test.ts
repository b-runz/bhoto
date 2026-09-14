import { describe, expect, test } from "bun:test";
import { companionsFor, dimensionsFor, isAssetTable } from "../src/assets";
import type { AssetTable } from "../src/assets";

/** Three keys, sorted, the way buildIndex emits them. */
function table(): AssetTable {
  return {
    keys: ["2024/01/01/A.jpg", "2024/01/02/B.jpg", "2024/01/03/C.mp4"],
    width: new Uint32Array([4032, 0, 1920]),
    height: new Uint32Array([3024, 0, 1080]),
    companions: [
      [".thumbs/2024/01/01/A.jpg", "2024/01/01/A.MOV", ".faces/2024/01/01/A.jpg.json.gz"],
      [],
      [".thumbs/2024/01/03/C.mp4"],
    ],
  };
}

describe("dimensionsFor", () => {
  test("returns the row's dimensions", () => {
    expect(dimensionsFor(table(), "2024/01/01/A.jpg")).toEqual({ w: 4032, h: 3024 });
    expect(dimensionsFor(table(), "2024/01/03/C.mp4")).toEqual({ w: 1920, h: 1080 });
  });

  test("a zero dimension means the phone did not know, so nothing is returned", () => {
    expect(dimensionsFor(table(), "2024/01/02/B.jpg")).toBeUndefined();
  });

  test("an unknown key returns nothing", () => {
    expect(dimensionsFor(table(), "2024/01/01/Z.jpg")).toBeUndefined();
    expect(dimensionsFor(table(), "")).toBeUndefined();
  });
});

describe("companionsFor", () => {
  test("returns the row's companion objects in stored order", () => {
    expect(companionsFor(table(), "2024/01/01/A.jpg")).toEqual([
      ".thumbs/2024/01/01/A.jpg",
      "2024/01/01/A.MOV",
      ".faces/2024/01/01/A.jpg.json.gz",
    ]);
  });

  test("a row with no companions and an unknown key both yield an empty list", () => {
    expect(companionsFor(table(), "2024/01/02/B.jpg")).toEqual([]);
    expect(companionsFor(table(), "nope.jpg")).toEqual([]);
  });

  test("lookups work for the first and the last key", () => {
    // Binary search off-by-ones live at the ends.
    expect(companionsFor(table(), "2024/01/01/A.jpg")).toHaveLength(3);
    expect(companionsFor(table(), "2024/01/03/C.mp4")).toHaveLength(1);
  });
});

describe("isAssetTable", () => {
  test("accepts a table as buildIndex emits it", () => {
    expect(isAssetTable(table())).toBe(true);
  });

  test("accepts an empty table", () => {
    expect(
      isAssetTable({ keys: [], width: new Uint32Array(0), height: new Uint32Array(0), companions: [] }),
    ).toBe(true);
  });

  test("rejects null, undefined and records of another shape", () => {
    expect(isAssetTable(null)).toBe(false);
    expect(isAssetTable(undefined)).toBe(false);
    expect(isAssetTable({ keys: ["a"], width: [1], height: [1], companions: [[]] })).toBe(false);
    expect(isAssetTable({ ...table(), companions: undefined })).toBe(false);
  });

  test("rejects a table whose arrays disagree in length", () => {
    expect(isAssetTable({ ...table(), height: new Uint32Array(2) })).toBe(false);
    expect(isAssetTable({ ...table(), companions: [[]] })).toBe(false);
  });
});
