/**
 * Text normalization matching SQLite FTS5's `unicode61` tokenizer with its
 * default `remove_diacritics 1`: strip combining marks, fold case, and treat
 * every non-alphanumeric character as a separator.
 *
 * Both sides of an OCR comparison run through this -- the text at import
 * time and the query at search time -- so "Café-Nord!" and "cafe nord"
 * compare equal. Skipping it on either side turns phrase matching into a
 * silent no-op.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
