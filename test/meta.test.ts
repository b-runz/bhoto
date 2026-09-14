import { describe, expect, test } from "bun:test";
import { MeasuredProvider, sameShape } from "../src/meta";
import type { AssetTable } from "../src/assets";
import type { PhotoMeta } from "../src/types";

const KEY = "2024/01/01/A.jpg";
const UNKNOWN = "2024/01/02/B.jpg";

function table(): AssetTable {
  return {
    keys: [KEY, UNKNOWN],
    width: new Uint32Array([4032, 0]),
    height: new Uint32Array([3024, 0]),
    companions: [[], []],
  };
}

/** A provider whose persistence is a recorder rather than IndexedDB. */
function provider(measured: Array<[string, PhotoMeta]> = []) {
  const written: Array<[string, PhotoMeta]> = [];
  const persist = async (entries: Iterable<[string, PhotoMeta]>): Promise<void> => {
    written.push(...entries);
  };
  const p = new MeasuredProvider(new Map(measured), table(), persist);
  return { p, written };
}

describe("sameShape", () => {
  test("nothing known is never the same shape", () => {
    expect(sameShape(undefined, 400, 300)).toBe(false);
  });

  test("equal aspect at a different scale is the same shape", () => {
    // The snapshot knows the original; the browser measures the thumbnail.
    expect(sameShape({ w: 4032, h: 3024 }, 400, 300)).toBe(true);
    expect(sameShape({ w: 4284, h: 5712 }, 300, 400)).toBe(true);
  });

  test("a thumbnail rounded to whole pixels still matches", () => {
    // 4032/3024 = 1.3333; 533/400 = 1.3325.
    expect(sameShape({ w: 4032, h: 3024 }, 533, 400)).toBe(true);
  });

  test("a rotated photo is not the same shape", () => {
    expect(sameShape({ w: 4032, h: 3024 }, 300, 400)).toBe(false);
  });

  test("a different crop is not the same shape", () => {
    // 3:2 against 4:3 is an 11% difference.
    expect(sameShape({ w: 3000, h: 2000 }, 400, 300)).toBe(false);
  });

  test("degenerate sizes are never the same shape", () => {
    expect(sameShape({ w: 0, h: 0 }, 400, 300)).toBe(false);
    expect(sameShape({ w: 4032, h: 3024 }, 0, 300)).toBe(false);
  });
});

describe("MeasuredProvider", () => {
  test("answers from the snapshot before anything has been measured", () => {
    const { p } = provider();
    expect(p.get(KEY)).toEqual({ w: 4032, h: 3024 });
  });

  test("knows nothing about a key the snapshot has no dimensions for", () => {
    const { p } = provider();
    expect(p.get(UNKNOWN)).toBeUndefined();
    expect(p.get("2024/01/03/C.jpg")).toBeUndefined();
  });

  test("a measurement wins over the snapshot", () => {
    const { p } = provider([[KEY, { w: 300, h: 400 }]]);
    expect(p.get(KEY)).toEqual({ w: 300, h: 400 });
  });

  test("a measurement that agrees with the snapshot is not persisted", async () => {
    const { p, written } = provider();
    p.observe(KEY, 400, 300);
    await Bun.sleep(500);
    expect(written).toEqual([]);
    // ...and the snapshot's answer stands, so layout does not change.
    expect(p.get(KEY)).toEqual({ w: 4032, h: 3024 });
  });

  test("a measurement that disagrees with the snapshot is persisted and served", async () => {
    const { p, written } = provider();
    p.observe(KEY, 300, 400);
    expect(p.get(KEY)).toEqual({ w: 300, h: 400 });
    await Bun.sleep(500);
    expect(written).toEqual([[KEY, { w: 300, h: 400 }]]);
  });

  test("a measurement for an unknown key is persisted", async () => {
    const { p, written } = provider();
    p.observe(UNKNOWN, 400, 300);
    expect(p.get(UNKNOWN)).toEqual({ w: 400, h: 300 });
    await Bun.sleep(500);
    expect(written).toEqual([[UNKNOWN, { w: 400, h: 300 }]]);
  });

  test("ignores a degenerate measurement", async () => {
    const { p, written } = provider();
    p.observe(UNKNOWN, 0, 300);
    await Bun.sleep(500);
    expect(p.get(UNKNOWN)).toBeUndefined();
    expect(written).toEqual([]);
  });

  test("works with no snapshot at all", () => {
    const p = new MeasuredProvider(new Map(), null, async () => {});
    expect(p.get(KEY)).toBeUndefined();
  });
});
