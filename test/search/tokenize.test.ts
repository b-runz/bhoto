import { describe, expect, test } from "bun:test";
import { normalize } from "../../src/search/tokenize";

describe("normalize", () => {
  test("folds case and splits on punctuation", () => {
    expect(normalize("Café-Nord!")).toBe("cafe nord");
  });

  test("strips diacritics the way unicode61 does by default", () => {
    expect(normalize("ÅRHUS")).toBe("arhus");
    expect(normalize("naïve")).toBe("naive");
  });

  test("leaves letters that are not decomposable alone", () => {
    // ø and æ carry no combining mark, so unicode61 keeps them as-is.
    expect(normalize("Rødgrød")).toBe("rødgrød");
    expect(normalize("Æble")).toBe("æble");
  });

  test("keeps digits and separates them like any other token", () => {
    expect(normalize("ICU 400548 8")).toBe("icu 400548 8");
  });

  test("splits possessives and hyphenated words into separate tokens", () => {
    expect(normalize("cat's")).toBe("cat s");
    expect(normalize("well-known")).toBe("well known");
  });

  test("collapses runs of separators and trims the edges", () => {
    expect(normalize("  a  --  b  ")).toBe("a b");
    expect(normalize("\n\tDanskeBank\n")).toBe("danskebank");
  });

  test("returns an empty string for input with no token characters", () => {
    expect(normalize("")).toBe("");
    expect(normalize("   ")).toBe("");
    expect(normalize("!!! ???")).toBe("");
  });
});
