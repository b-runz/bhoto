/**
 * What the phone's snapshot knows about each object in the bucket beyond
 * what search needs: its pixel dimensions, and the other objects the phone
 * uploaded alongside it.
 *
 * Built by `search/import.ts` from `gallery_asset`, persisted by
 * `search/store.ts`, and read by two consumers that have nothing to do with
 * search -- the grid's dimension provider (`meta.ts`) and the delete path
 * (`main.ts`). It covers every row with a `remote_key`, whatever its
 * visibility: an archived photo is not searchable, but its object is in the
 * bucket, so the grid lays it out and a delete has to know its companions.
 *
 * Columnar, like the search index: one record in IndexedDB rather than one
 * per photo, and `keys` sorted so a lookup is a binary search.
 */
import type { PhotoMeta } from "./types";

export interface AssetTable {
  /** Every `remote_key` in the snapshot, sorted by UTF-16 code unit. */
  keys: string[];
  /**
   * Display-oriented pixel size, parallel to `keys`. The phone already
   * swaps width and height for a rotated photo before it stores them (its
   * Android sync does so at discovery; its migration did so from EXIF), so
   * no orientation correction happens here. `0` means the phone did not
   * know.
   */
  width: Uint32Array;
  height: Uint32Array;
  /**
   * Parallel to `keys`: the non-empty `thumb_key`, `live_photo_key` and
   * `face_sidecar_key` of the row, in that order. These are the objects the
   * phone's own delete removes after the original, and so does this app's.
   */
  companions: string[][];
}

/**
 * Whether a stored record is an asset table this build can use. Structured
 * clone keeps typed arrays typed, so a plain array here means the record did
 * not come from `saveImport`.
 */
export function isAssetTable(value: unknown): value is AssetTable {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AssetTable>;
  return (
    Array.isArray(candidate.keys) &&
    candidate.width instanceof Uint32Array &&
    candidate.height instanceof Uint32Array &&
    Array.isArray(candidate.companions) &&
    candidate.width.length === candidate.keys.length &&
    candidate.height.length === candidate.keys.length &&
    candidate.companions.length === candidate.keys.length
  );
}

/** The row's size, or undefined when the phone did not know it. */
export function dimensionsFor(table: AssetTable, key: string): PhotoMeta | undefined {
  const at = indexOf(table, key);
  if (at === -1) return undefined;
  const w = table.width[at]!;
  const h = table.height[at]!;
  return w > 0 && h > 0 ? { w, h } : undefined;
}

/** The row's companion objects, or an empty list for an unknown key. */
export function companionsFor(table: AssetTable, key: string): string[] {
  const at = indexOf(table, key);
  return at === -1 ? [] : table.companions[at]!;
}

/** Binary search over the sorted `keys`. Plain `<`, matching the sort. */
function indexOf(table: AssetTable, key: string): number {
  const keys = table.keys;
  let low = 0;
  let high = keys.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const probe = keys[mid]!;
    if (probe === key) return mid;
    if (probe < key) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}
