import { describe, expect, test } from "bun:test";
import { fold, normalize } from "../../src/search/tokenize";

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

describe("fold", () => {
  test("strips diacritics and ligatures via the lookup table", () => {
    expect(fold("Ærø")).toBe("aero");
    expect(fold("Straße")).toBe("strasse");
    expect(fold("Łódź")).toBe("lodz");
    expect(fold("İstanbul")).toBe("istanbul");
  });

  test("splits on punctuation and lowercases", () => {
    expect(fold("IMG_4821.jpg")).toBe("img 4821 jpg");
    expect(fold("Café-Nord!")).toBe("cafe nord");
  });

  test("preserves scripts that are not in the Latin diacritic table", () => {
    expect(fold("Москва")).toBe("москва");
    expect(fold("日本語")).toBe("日本語");
  });

  test("drops characters that are numeric but not \\p{Nd}, unlike normalize's \\p{N}", () => {
    expect(fold("m²")).toBe("m");
  });

  test("collapses whitespace and trims the edges", () => {
    expect(fold("  x  ")).toBe("x");
  });

  test("returns an empty string for empty input", () => {
    expect(fold("")).toBe("");
  });

  test("differs from normalize on letters unicode61 does not decompose", () => {
    // ø and æ carry no combining mark, so unicode61 (normalize) keeps them
    // as-is, but the phone's lookup table (fold) strips them regardless.
    expect(normalize("Ærø")).toBe("ærø");
    expect(fold("Ærø")).toBe("aero");
  });
});
