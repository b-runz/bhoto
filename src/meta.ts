/**
 * The grid never reads dimensions from storage directly -- it asks a
 * provider. MeasuredProvider learns them from thumbnails as they load. A
 * SqliteProvider can implement the same two methods later; swapping is one
 * line in main.ts.
 */
import { getAllMeta, putMetaBatch } from "./db";
import type { PhotoMeta } from "./types";

export interface MetaProvider {
  /** Synchronous: layout runs per frame and cannot await. */
  get(key: string): PhotoMeta | undefined;
  /** Record dimensions learned from a loaded image. */
  observe(key: string, w: number, h: number): void;
}

const FLUSH_MS = 400;

export class MeasuredProvider implements MetaProvider {
  private cache = new Map<string, PhotoMeta>();
  private pending = new Map<string, PhotoMeta>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Load the whole map once; it is small and layout needs it synchronously. */
  static async load(): Promise<MeasuredProvider> {
    const provider = new MeasuredProvider();
    provider.cache = await getAllMeta();
    return provider;
  }

  get(key: string): PhotoMeta | undefined {
    return this.cache.get(key);
  }

  observe(key: string, w: number, h: number): void {
    if (!(w > 0 && h > 0)) return;
    const existing = this.cache.get(key);
    if (existing && existing.w === w && existing.h === h) return;

    // Preserve any extra fields a future provider may have written.
    const record: PhotoMeta = { ...existing, w, h };
    this.cache.set(key, record);
    this.pending.set(key, record);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const batch = this.pending;
      this.pending = new Map();
      void putMetaBatch(batch);
    }, FLUSH_MS);
  }
}
