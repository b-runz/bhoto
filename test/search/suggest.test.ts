import { describe, expect, test } from "bun:test";
import { cosine, mergeSuggestions, pickPass, scoreLabels } from "../../src/search/suggest";
import type { Embeddings, Scored } from "../../src/search/suggest";

function embeddings(rows: Array<[string, number[]]>, dims: number, model = "gemini-embedding-001"): Embeddings {
  const vectors = new Float32Array(rows.length * dims);
  rows.forEach(([, vec], i) => vectors.set(vec, i * dims));
  return { labels: rows.map(([label]) => label), vectors, dims, model };
}

describe("cosine", () => {
  const dims = 3;

  test("is 1 for identical directions and 0 for orthogonal ones", () => {
    const a = [1, 0, 0];
    expect(cosine(a, 0, [2, 0, 0], dims)).toBeCloseTo(1, 6);
    expect(cosine(a, 0, [0, 1, 0], dims)).toBeCloseTo(0, 6);
    expect(cosine(a, 0, [-1, 0, 0], dims)).toBeCloseTo(-1, 6);
  });

  test("reads the second operand from an offset", () => {
    const packed = [9, 9, 9, 1, 0, 0];
    expect(cosine([1, 0, 0], 0, packed.slice(3), dims)).toBeCloseTo(1, 6);
  });

  test("returns 0 rather than NaN for a zero vector", () => {
    expect(cosine([0, 0, 0], 0, [1, 0, 0], dims)).toBe(0);
    expect(cosine([1, 0, 0], 0, [0, 0, 0], dims)).toBe(0);
  });
});

describe("scoreLabels", () => {
  const dims = 3;

  test("scores every label and sorts highest first", () => {
    const e = embeddings(
      [
        ["tent", [1, 0, 0]],
        ["elk", [0, 1, 0]],
        ["telephone", [0.7, 0.7, 0]],
      ],
      dims,
    );
    const scored = scoreLabels(e, [1, 0, 0]);
    expect(scored.map((s) => s.label)).toEqual(["tent", "telephone", "elk"]);
    expect(scored[0]?.score).toBeCloseTo(1, 6);
  });

  test("returns nothing when the query vector's length disagrees", () => {
    // Belt and braces: a row of another dimensionality must not be allowed
    // to read past the end of its slice and abort the whole pass.
    const e = embeddings([["tent", [1, 0, 0]]], dims);
    expect(scoreLabels(e, [1, 0])).toEqual([]);
  });

  test("returns an empty list for an empty store", () => {
    expect(scoreLabels(embeddings([], dims), [1, 0, 0])).toEqual([]);
  });

  test("returns nothing when the store's model doesn't match, even at the same dimensionality", () => {
    // import.ts filters by model at import time, but the index is only
    // rebuilt when the snapshot changes, not when the pinned model does --
    // so this has to be enforced again at query time.
    const e = embeddings([["tent", [1, 0, 0]]], dims, "some-other-model");
    expect(scoreLabels(e, [1, 0, 0])).toEqual([]);
  });
});

describe("pickPass", () => {
  const s = (label: string, score: number): Scored => ({ label, score });

  test("keeps the pass whose top match is closer, discarding the other entirely", () => {
    // The "telt" case: the untranslated pass finds lexical coincidences
    // above threshold, but the translated pass finds the real neighbour.
    // The loser's matches are noise and must not be merged in.
    const untranslated = [s("elk", 0.62), s("telephone", 0.58)];
    const translated = [s("tent", 0.91), s("camping", 0.66)];
    expect(pickPass(untranslated, translated)).toEqual(["tent", "camping"]);
  });

  test("keeps the untranslated pass when it wins", () => {
    expect(pickPass([s("train", 0.9)], [s("lit", 0.5)])).toEqual(["train"]);
  });

  test("drops anything below the 0.5 threshold", () => {
    expect(pickPass([s("a", 0.9), s("b", 0.5), s("c", 0.49)], [])).toEqual(["a", "b"]);
  });

  test("returns at most five", () => {
    const many = [0.99, 0.98, 0.97, 0.96, 0.95, 0.94].map((score, i) => s(`l${i}`, score));
    expect(pickPass(many, [])).toEqual(["l0", "l1", "l2", "l3", "l4"]);
  });

  test("handles either pass being empty", () => {
    expect(pickPass([], [])).toEqual([]);
    expect(pickPass([], [s("tent", 0.8)])).toEqual(["tent"]);
    expect(pickPass([s("tent", 0.8)], [])).toEqual(["tent"]);
  });

  test("breaks a tie on equal top scores in favour of the untranslated pass", () => {
    // Strict ">" is what decides this: a translated pass that merely equals
    // the untranslated pass's best score must not displace it.
    const untranslated = [s("train", 0.8)];
    const translated = [s("tog", 0.8)];
    expect(pickPass(untranslated, translated)).toEqual(["train"]);
  });
});

describe("mergeSuggestions", () => {
  test("puts places first and labels after", () => {
    const places = [{ display: "Aarhus (Denmark)", query: "Aarhus" }];
    expect(mergeSuggestions(places, ["train"])).toEqual([
      { display: "Aarhus (Denmark)", query: "Aarhus" },
      { display: "train", query: "train" },
    ]);
  });

  test("deduplicates on query, case-insensitively, keeping the first", () => {
    const places = [{ display: "Train (France)", query: "Train" }];
    expect(mergeSuggestions(places, ["train"])).toEqual([
      { display: "Train (France)", query: "Train" },
    ]);
  });

  test("returns an empty list when both sides are empty", () => {
    expect(mergeSuggestions([], [])).toEqual([]);
  });
});
