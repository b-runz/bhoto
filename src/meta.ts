/**
 * The grid never reads dimensions from storage directly -- it asks a
 * provider. MeasuredProvider answers from two sources: the phone's snapshot,
 * which knows most photos' sizes before a single thumbnail has loaded, and
 * measurements taken from thumbnails as they load, which are the truth about
 * what is actually drawn and win when the two disagree.
 *
 * Only disagreements are persisted. The snapshot is already stored in one
 * record, so re-recording every photo that matches it would just fill the
 * `meta` store with copies of what the snapshot said.
 */
import { getAllMeta, putMetaBatch } from "./db";
import { dimensionsFor } from "./assets";
import type { AssetTable } from "./assets";
import type { PhotoMeta } from "./types";

export interface MetaProvider {
  /** Synchronous: layout runs per frame and cannot await. */
  get(key: string): PhotoMeta | undefined;
  /** Record dimensions learned from a loaded image. */
  observe(key: string, w: number, h: number): void;
}

const FLUSH_MS = 400;

/**
 * How far two aspect ratios may differ and still count as the same shape:
 * one percent, which is two pixels of width on a 200 px row. The snapshot
 * holds the original's size and the browser measures a thumbnail rounded to
 * whole pixels, so exact equality would call every photo a mismatch and
 * reflow every section as its thumbnails arrived. A rotated photo (3:2
 * against 2:3) or a different crop (3:2 against 4:3) is far outside this.
 */
const SAME_SHAPE = 0.01;

/**
 * Whether a freshly measured `w`x`h` has the aspect ratio `known` already
 * describes. Only the ratio matters: layout never uses the pixel counts.
 */
export function sameShape(known: PhotoMeta | undefined, w: number, h: number): boolean {
  if (known === undefined) return false;
  if (!(known.w > 0 && known.h > 0 && w > 0 && h > 0)) return false;
  const a = known.w / known.h;
  const b = w / h;
  return Math.abs(a - b) / a < SAME_SHAPE;
}

export class MeasuredProvider implements MetaProvider {
  private pending = new Map<string, PhotoMeta>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * `measured` is what earlier sessions learned from thumbnails; `assets`
   * is the snapshot's table, or null when none has been imported. `persist`
   * is injectable so the class can be exercised without IndexedDB.
   */
  constructor(
    private readonly measured: Map<string, PhotoMeta> = new Map(),
    private readonly assets: AssetTable | null = null,
    private readonly persist: (entries: Iterable<[string, PhotoMeta]>) => Promise<void> = putMetaBatch,
  ) {}

  /** Load the measured map once; it is small and layout needs it synchronously. */
  static async load(assets: AssetTable | null): Promise<MeasuredProvider> {
    return new MeasuredProvider(await getAllMeta(), assets);
  }

  get(key: string): PhotoMeta | undefined {
    const measured = this.measured.get(key);
    if (measured !== undefined) return measured;
    return this.assets === null ? undefined : dimensionsFor(this.assets, key);
  }

  observe(key: string, w: number, h: number): void {
    if (!(w > 0 && h > 0)) return;
    if (sameShape(this.get(key), w, h)) return;

    // Preserve any extra fields a future provider may have written.
    const record: PhotoMeta = { ...this.measured.get(key), w, h };
    this.measured.set(key, record);
    this.pending.set(key, record);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const batch = this.pending;
      this.pending = new Map();
      void this.persist(batch).catch(() => {});
    }, FLUSH_MS);
  }
}
