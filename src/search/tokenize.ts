/**
 * Two folding functions, for two different sides of the same search.
 *
 * `normalize` matches SQLite FTS5's `unicode61` tokenizer with its default
 * `remove_diacritics 1` (NFD-decompose, strip combining marks, lowercase,
 * split on non-alphanumerics): it exists so this module can reason about how
 * the phone's FTS5 index actually tokenized the text it indexed.
 *
 * `fold` is a verbatim port of the phone's `foldForSearch`
 * (`lib/infrastructure/db/text_folding.dart`), which folds the user's typed
 * query before it goes into a `MATCH` expression. It intentionally does not
 * use NFD decomposition -- Dart's `String` has no built-in Unicode
 * normalisation, so the phone strips diacritics with a lookup table instead,
 * and that table disagrees with NFD on letters like ø, æ and ß (see the
 * unified-asset-model spec's "Two folding functions" section). Both
 * functions are needed for parity: `normalize` documents what the index
 * contains, `fold` reproduces exactly what the phone sends as a query, and
 * the viewer must query the way the phone does, not the way FTS5 would fold
 * on its own -- otherwise `MATCH` silently returns no rows instead of
 * erroring.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Maps precomposed accented/ligature Latin-1 Supplement, Latin Extended-A/B
 * and other common accented characters to their unaccented ASCII base
 * letter. Covers both cases explicitly rather than relying on lowercasing
 * before the strip, since some accented uppercase forms don't lowercase to
 * an entry that would otherwise be in a smaller table.
 *
 * Copied entry for entry from the phone's `_diacriticMap`
 * (`lib/infrastructure/db/text_folding.dart`) -- do not "improve" this with
 * `String.prototype.normalize("NFD")`, which strips ø, æ and ß differently
 * (or not at all) and would silently break query/index parity.
 */
const DIACRITIC_MAP: Record<string, string> = {
  // A
  À: "A", Á: "A", Â: "A", Ã: "A", Ä: "A", Å: "A", Ā: "A", Ă: "A", Ą: "A",
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", ā: "a", ă: "a", ą: "a",
  // AE
  Æ: "AE", æ: "ae",
  // C
  Ç: "C", Ć: "C", Ĉ: "C", Ċ: "C", Č: "C",
  ç: "c", ć: "c", ĉ: "c", ċ: "c", č: "c",
  // D
  Ð: "D", Ď: "D", Đ: "D",
  ð: "d", ď: "d", đ: "d",
  // E
  È: "E", É: "E", Ê: "E", Ë: "E", Ē: "E", Ĕ: "E", Ė: "E", Ę: "E", Ě: "E",
  è: "e", é: "e", ê: "e", ë: "e", ē: "e", ĕ: "e", ė: "e", ę: "e", ě: "e",
  // G
  Ĝ: "G", Ğ: "G", Ġ: "G", Ģ: "G",
  ĝ: "g", ğ: "g", ġ: "g", ģ: "g",
  // H
  Ĥ: "H", Ħ: "H",
  ĥ: "h", ħ: "h",
  // I
  Ì: "I", Í: "I", Î: "I", Ï: "I", Ĩ: "I", Ī: "I", Ĭ: "I", Į: "I", İ: "I",
  ì: "i", í: "i", î: "i", ï: "i", ĩ: "i", ī: "i", ĭ: "i", į: "i", ı: "i",
  // IJ
  Ĳ: "IJ", ĳ: "ij",
  // J
  Ĵ: "J", ĵ: "j",
  // K
  Ķ: "K", ķ: "k",
  // L
  Ĺ: "L", Ļ: "L", Ľ: "L", Ŀ: "L", Ł: "L",
  ĺ: "l", ļ: "l", ľ: "l", ŀ: "l", ł: "l",
  // N
  Ñ: "N", Ń: "N", Ņ: "N", Ň: "N", Ŋ: "N",
  ñ: "n", ń: "n", ņ: "n", ň: "n", ŋ: "n", ŉ: "n",
  // O
  Ò: "O", Ó: "O", Ô: "O", Õ: "O", Ö: "O", Ø: "O", Ō: "O", Ŏ: "O", Ő: "O",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o", ō: "o", ŏ: "o", ő: "o",
  // OE
  Œ: "OE", œ: "oe",
  // R
  Ŕ: "R", Ŗ: "R", Ř: "R",
  ŕ: "r", ŗ: "r", ř: "r",
  // S
  Ś: "S", Ŝ: "S", Ş: "S", Š: "S",
  ś: "s", ŝ: "s", ş: "s", š: "s", ß: "ss",
  // T
  Ţ: "T", Ť: "T", Ŧ: "T",
  ţ: "t", ť: "t", ŧ: "t",
  // U
  Ù: "U", Ú: "U", Û: "U", Ü: "U", Ũ: "U", Ū: "U", Ŭ: "U", Ů: "U", Ű: "U", Ų: "U",
  ù: "u", ú: "u", û: "u", ü: "u", ũ: "u", ū: "u", ŭ: "u", ů: "u", ű: "u", ų: "u",
  // W
  Ŵ: "W", ŵ: "w",
  // Y
  Ý: "Y", Ŷ: "Y", Ÿ: "Y",
  ý: "y", ŷ: "y", ÿ: "y",
  // Z
  Ź: "Z", Ż: "Z", Ž: "Z",
  ź: "z", ż: "z", ž: "z",
};

/**
 * Strips characters from {@link DIACRITIC_MAP} to their unaccented base
 * letter, leaving anything not in the map (including ordinary ASCII and
 * non-Latin scripts) untouched. Iterates by code point, not by UTF-16 code
 * unit, matching Dart's `String.runes`.
 */
function stripDiacritics(input: string): string {
  let result = "";
  for (const char of input) {
    result += DIACRITIC_MAP[char] ?? char;
  }
  return result;
}

// `\p{L}` (any Unicode letter) and `\p{Nd}` (any Unicode decimal digit),
// matching the Dart file's `RegExp(r'[^\p{L}\p{Nd}]+', unicode: true)`. An
// ASCII-only class would treat every non-Latin letter (Cyrillic, Greek,
// CJK, ...) as punctuation and fold the whole string to nothing.
const NON_ALPHANUMERIC = /[^\p{L}\p{Nd}]+/gu;

/**
 * Verbatim port of the phone's `foldForSearch`
 * (`lib/infrastructure/db/text_folding.dart`): strip diacritics via
 * {@link DIACRITIC_MAP}, lowercase, replace every run of characters that are
 * not a Unicode letter or decimal digit with a single space, and trim.
 *
 * See the module doc comment above for why this must not be replaced with
 * `normalize`'s NFD-based approach.
 */
export function fold(text: string): string {
  return stripDiacritics(text).toLowerCase().replace(NON_ALPHANUMERIC, " ").trim();
}
