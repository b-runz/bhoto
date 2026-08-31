import { describe, expect, test } from "bun:test";
import { probeOffset, spaceOut } from "../src/rail";

const GAP = 22;
const H = 600;

/** Gaps between neighbours, as laid out. */
function gaps(ys: number[]): number[] {
  return ys.slice(1).map((y, i) => y - ys[i]!);
}

describe("spaceOut", () => {
  test("leaves well-separated labels where they are", () => {
    const wanted = [40, 120, 300, 500];
    expect(spaceOut(wanted, GAP, H)).toEqual(wanted);
  });

  test("empty input stays empty", () => {
    expect(spaceOut([], GAP, H)).toEqual([]);
  });

  test("separates years stacked on the same pixel", () => {
    // Six sparse years all landing at 480 -- the reported smudge.
    const ys = spaceOut([100, 480, 480, 480, 480, 480, 480], GAP, H);
    for (const gap of gaps(ys)) expect(gap).toBeGreaterThanOrEqual(GAP - 1e-9);
  });

  test("keeps labels in chronological order", () => {
    const ys = spaceOut([10, 12, 13, 14, 200, 201, 590, 595, 599], GAP, H);
    for (const gap of gaps(ys)) expect(gap).toBeGreaterThan(0);
  });

  test("never runs off the bottom of the rail", () => {
    const ys = spaceOut([560, 570, 580, 590, 599, 599, 599], GAP, H);
    for (const y of ys) expect(y).toBeLessThanOrEqual(H);
  });

  test("crowding at the bottom pushes labels upward, not off", () => {
    const ys = spaceOut([599, 599, 599], GAP, H);
    expect(ys[0]).toBeLessThan(ys[1]!);
    expect(ys[2]).toBeLessThanOrEqual(H);
    for (const gap of gaps(ys)) expect(gap).toBeCloseTo(GAP, 6);
  });

  test("more labels than the rail can hold compress instead of overflowing", () => {
    // 40 years cannot all clear 22px in 600px, so the gap has to tighten.
    const ys = spaceOut(Array.from({ length: 40 }, () => 300), GAP, H);
    expect(new Set(ys).size).toBe(ys.length);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(H);
    }
    for (const gap of gaps(ys)) expect(gap).toBeGreaterThan(0);
  });

  test("stays inside the rail at every window height", () => {
    const wanted = Array.from({ length: 18 }, (_, i) => i * 33);
    for (const height of [180, 240, 300, 420, 600, 900]) {
      const ys = spaceOut(wanted, GAP, height);
      for (const y of ys) {
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(height);
      }
      for (const gap of gaps(ys)) expect(gap).toBeGreaterThan(0);
    }
  });

  test("a single label is untouched", () => {
    expect(spaceOut([250], GAP, H)).toEqual([250]);
  });
});

describe("probeOffset", () => {
  const MAX = 5000;      // scrollHeight - clientHeight
  const VIEW = 300;      // clientHeight
  const CONTENT = MAX + VIEW;

  test("at the very top it samples the top edge", () => {
    expect(probeOffset(0, MAX, VIEW)).toBe(0);
  });

  test("at the very bottom it samples the bottom of the content", () => {
    // The reported bug: the last section starts below scrollHeight-clientHeight
    // and so was never reachable by sampling the top edge alone.
    expect(probeOffset(1, MAX, VIEW)).toBe(CONTENT);
  });

  test("reaches a final section shorter than the viewport", () => {
    // 2009 holds one photo: its section starts past max scroll.
    const lastSectionTop = MAX + 120;
    expect(probeOffset(1, MAX, VIEW)).toBeGreaterThan(lastSectionTop);
  });

  test("increases monotonically with scroll", () => {
    let previous = -1;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const probe = probeOffset(f, MAX, VIEW);
      expect(probe).toBeGreaterThan(previous);
      previous = probe;
    }
  });

  test("never samples past the end of the content", () => {
    for (let f = 0; f <= 1.0001; f += 0.1) {
      expect(probeOffset(f, MAX, VIEW)).toBeLessThanOrEqual(CONTENT);
    }
  });

  test("clamps a fraction outside 0..1", () => {
    expect(probeOffset(-3, MAX, VIEW)).toBe(0);
    expect(probeOffset(9, MAX, VIEW)).toBe(CONTENT);
  });

  test("content shorter than the viewport cannot scroll", () => {
    expect(probeOffset(0, 0, VIEW)).toBe(0);
  });
});
