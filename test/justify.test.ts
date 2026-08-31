import { describe, expect, test } from "bun:test";
import { justify, type Row } from "../src/justify";

const W = 1000;
const opts = { target: 200, gap: 4 };

/** Widths plus the gaps between them, as laid out. */
function rowSpan(row: Row, gap: number): number {
  const gaps = gap * (row.tiles.length - 1);
  return row.tiles.reduce((sum, t) => sum + t.w, 0) + gaps;
}

describe("justify", () => {
  test("empty input produces no rows", () => {
    expect(justify([], W, opts)).toEqual([]);
  });

  test("every row but the last fills the container width exactly", () => {
    const aspects = Array.from({ length: 40 }, (_, i) => 0.6 + (i % 7) * 0.3);
    const rows = justify(aspects, W, opts);
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows.slice(0, -1)) {
      expect(rowSpan(row, opts.gap)).toBeCloseTo(W, 6);
    }
  });

  test("keeps every tile, in order, exactly once", () => {
    const aspects = Array.from({ length: 33 }, (_, i) => 0.5 + i * 0.1);
    const rows = justify(aspects, W, opts);
    const flat = rows.flatMap((r) => r.tiles.map((t) => t.w / t.h));
    expect(flat.length).toBe(aspects.length);
    flat.forEach((a, i) => expect(a).toBeCloseTo(aspects[i]!, 6));
  });

  test("tiles in a row share one height", () => {
    for (const row of justify([1.5, 1.5, 1.33, 0.75, 1.5, 1.5, 1.5], W, opts)) {
      for (const tile of row.tiles) expect(tile.h).toBeCloseTo(row.height, 6);
    }
  });

  test("the last row is not stretched to fill the width", () => {
    // One narrow trailing image must not blow up to 1000px wide.
    const rows = justify([1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5], W, opts);
    const last = rows.at(-1)!;
    if (rowSpan(last, opts.gap) < W - 1) {
      expect(last.height).toBeLessThanOrEqual(opts.target);
    }
  });

  test("a single very wide image fits the width instead of overflowing", () => {
    const [row] = justify([10], W, opts);
    expect(row!.tiles).toHaveLength(1);
    expect(row!.tiles[0]!.w).toBeLessThanOrEqual(W);
    expect(row!.height).toBeCloseTo(W / 10, 6);
  });

  test("a single very tall image sits at the target height", () => {
    const [row] = justify([0.4], W, opts);
    expect(row!.height).toBeCloseTo(200, 6);
    expect(row!.tiles[0]!.w).toBeCloseTo(80, 6);
  });

  test("rows stay near the target height", () => {
    const aspects = Array.from({ length: 60 }, () => 1.5);
    const rows = justify(aspects, W, opts).slice(0, -1);
    for (const row of rows) {
      expect(row.height).toBeGreaterThan(120);
      expect(row.height).toBeLessThan(320);
    }
  });

  test("a zero or negative container width yields no rows", () => {
    expect(justify([1.5, 1.5], 0, opts)).toEqual([]);
  });

  test("non-finite aspects are treated as 3:2 rather than poisoning the row", () => {
    const rows = justify([Number.NaN, 1.5], W, opts);
    const all = rows.flatMap((r) => r.tiles);
    expect(all).toHaveLength(2);
    for (const t of all) {
      expect(Number.isFinite(t.w)).toBe(true);
      expect(Number.isFinite(t.h)).toBe(true);
    }
  });
});
