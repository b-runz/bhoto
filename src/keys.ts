import type { Item, MediaKind } from "./types";

export const THUMB_PREFIX = ".thumbs/";

const IMAGE_EXT = new Set(["jpg", "jpeg"]);
const VIDEO_EXT = new Set(["mp4"]);

/** YYYY/MM/DD/<name>.<ext> with no further nesting. */
const KEY_RE = /^(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\.([A-Za-z0-9]+)$/;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The extension describes the ORIGINAL. Thumbnails are always JPEG
 * regardless of what they are called, so nothing in the grid may use this.
 */
export function mediaKind(key: string): MediaKind {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  return VIDEO_EXT.has(ext) ? "video" : "image";
}

/** Thumbnail for an original. Extension deliberately preserved. */
export function thumbKey(key: string): string {
  return THUMB_PREFIX + key;
}

/**
 * Turn a listed key into an Item, or null if it is not a media file we
 * show. Rejects .thumbs/, unknown extensions, and malformed dates.
 */
export function parseKey(key: string, bytes: number): Item | null {
  if (key.startsWith(THUMB_PREFIX)) return null;

  const m = KEY_RE.exec(key);
  if (!m) return null;

  const [, yy, mm, dd, , rawExt] = m as unknown as string[];
  const ext = rawExt!.toLowerCase();
  if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) return null;

  const year = Number(yy), month = Number(mm), day = Number(dd);
  if (!isRealDate(year, month, day)) return null;

  return {
    key,
    date: `${yy}-${mm}-${dd}`,
    bytes,
    kind: VIDEO_EXT.has(ext) ? "video" : "image",
  };
}

/** Guards against 2022/13/01 and 2022/02/30 alike. */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year
    && d.getUTCMonth() === month - 1
    && d.getUTCDate() === day;
}

/**
 * "2022-08-29" -> "Mon, 29 Aug 2022".
 * Built from UTC parts so the label never slips a day by timezone.
 */
export function dateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[at.getUTCDay()]}, ${d} ${MONTHS[m - 1]} ${y}`;
}

/** "2018-09-15" -> "Sep 2018". Shown in the scroll thumb's bubble. */
export function monthLabel(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

/** Year portion of a "YYYY-MM-DD" date. */
export function yearOf(date: string): string {
  return date.slice(0, 4);
}
