/**
 * The photo grid: one element per date section, justified rows inside, and
 * only the sections near the viewport actually mounted.
 *
 * Layout maths is cheap and runs for every section up front, so placeholder
 * heights are correct before any DOM exists. Building DOM is the expensive
 * part, so that is what windowing defers.
 */
import { DEFAULT_ASPECT, justify, type Row } from "./justify";
import { yearOf } from "./keys";
import type { MetaProvider } from "./meta";
import { thumbUrl } from "./s3api";
import type { Creds, Item, Section } from "./types";

const TARGET_HEIGHT = 200;
const GAP = 4;
/** Mount anything within two viewports of the visible region. */
const MOUNT_MARGIN = "200% 0px";

interface SectionState {
  section: Section;
  root: HTMLElement;
  body: HTMLElement;
  rows: Row[];
  height: number;
  startIndex: number;
  mounted: boolean;
}

type SectionRoot = HTMLElement & { _state?: SectionState };

export interface GridOptions {
  container: HTMLElement;
  scroller: HTMLElement;
  creds: Creds;
  meta: MetaProvider;
  onOpen: (flatIndex: number) => void;
  /** Fires whenever the selected set changes size. */
  onSelectionChange?: (count: number) => void;
}

export class Grid {
  private states: SectionState[] = [];
  private width = 0;
  private dirty = new Set<SectionState>();
  private frame = 0;
  private observer: IntersectionObserver;
  private resize: ResizeObserver;
  /**
   * Signed thumbnail URLs, kept per key. Without this a reflow or a
   * remount would mint a fresh signature, and a different URL is a browser
   * cache miss -- re-downloading thumbnails already on disk.
   */
  private thumbUrls = new Map<string, Promise<string>>();
  /**
   * Selected photos, by key rather than by index. Keys survive a reflow, an
   * unmount and a re-render; indices survive none of those.
   */
  private selected = new Set<string>();
  /** Flat index the next shift-click extends from. */
  private anchor: number | null = null;

  constructor(private readonly options: GridOptions) {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const state = (entry.target as SectionRoot)._state;
          if (!state) continue;
          if (entry.isIntersecting) this.mount(state);
          else this.unmount(state);
        }
      },
      { root: options.scroller, rootMargin: MOUNT_MARGIN },
    );

    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(options.container);
  }

  /** Sections must already be ordered newest first. */
  setSections(sections: Section[]): void {
    this.teardown();
    this.selected.clear();
    this.anchor = null;
    this.width = this.options.container.clientWidth;

    let flat = 0;
    const fragment = document.createDocumentFragment();

    for (const section of sections) {
      const root: SectionRoot = document.createElement("section");
      root.className = "section";
      root.dataset.date = section.date;

      const header = document.createElement("h2");
      header.className = "section-header";
      header.textContent = section.label;

      const body = document.createElement("div");
      body.className = "section-body";

      root.append(header, body);
      fragment.append(root);

      const state: SectionState = {
        section,
        root,
        body,
        rows: [],
        height: 0,
        startIndex: flat,
        mounted: false,
      };
      root._state = state;

      this.relayout(state);
      this.states.push(state);
      this.observer.observe(root);
      flat += section.items.length;
    }

    this.options.container.replaceChildren(fragment);
    this.syncSelection();
  }

  /** Selected keys, in the grid's own order. */
  get selection(): string[] {
    const chosen = this.selected;
    return this.items.map((item) => item.key).filter((key) => chosen.has(key));
  }

  clearSelection(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.anchor = null;
    this.syncSelection();
  }

  /** True once anything is selected: a plain click then toggles, not opens. */
  private get selecting(): boolean {
    return this.selected.size > 0;
  }

  private toggle(key: string): void {
    if (!this.selected.delete(key)) this.selected.add(key);
    this.syncSelection();
  }

  /** Inclusive, in either direction. */
  private selectRange(from: number, to: number): void {
    const items = this.items;
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    for (let at = low; at <= high; at++) {
      const item = items[at];
      if (item) this.selected.add(item.key);
    }
    this.syncSelection();
  }

  /**
   * Repaints the selected state onto whatever is mounted. Tiles outside the
   * window have no DOM to update, and pick their class up in `tile()` when
   * they are painted.
   */
  private syncSelection(): void {
    this.options.container.classList.toggle("selecting", this.selecting);
    for (const el of this.options.container.querySelectorAll<HTMLElement>(".tile")) {
      const key = el.dataset.key;
      el.classList.toggle("selected", key !== undefined && this.selected.has(key));
    }
    this.options.onSelectionChange?.(this.selected.size);
  }

  /** Flattened chronological order — what the lightbox navigates. */
  get items(): Item[] {
    return this.states.flatMap((state) => state.section.items);
  }

  /** First section of each year, by pixel offset within the scroller. */
  yearAnchors(): Array<{ year: string; top: number }> {
    const seen = new Set<string>();
    const out: Array<{ year: string; top: number }> = [];
    for (const state of this.states) {
      const year = yearOf(state.section.date);
      if (seen.has(year)) continue;
      seen.add(year);
      out.push({ year, top: state.root.offsetTop });
    }
    return out;
  }

  /** Which date sits at a given scroll offset. Drives the thumb's bubble. */
  dateAtOffset(top: number): string | undefined {
    if (this.states.length === 0) return undefined;
    let low = 0;
    let high = this.states.length - 1;
    let best = this.states[0];
    while (low <= high) {
      const mid = (low + high) >> 1;
      const state = this.states[mid]!;
      if (state.root.offsetTop <= top) {
        best = state;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best?.section.date;
  }

  destroy(): void {
    this.teardown();
    this.observer.disconnect();
    this.resize.disconnect();
  }

  private teardown(): void {
    for (const state of this.states) this.observer.unobserve(state.root);
    this.states = [];
    this.dirty.clear();
    this.thumbUrls.clear();
  }

  private onResize(): void {
    const width = this.options.container.clientWidth;
    if (width === this.width || width <= 0) return;
    this.width = width;
    for (const state of this.states) {
      this.relayout(state);
      if (state.mounted) this.paint(state);
    }
  }

  /** Recompute rows and the placeholder height. Builds no DOM. */
  private relayout(state: SectionState): void {
    const aspects = state.section.items.map((item) => {
      const meta = this.options.meta.get(item.key);
      return meta && meta.h > 0 ? meta.w / meta.h : DEFAULT_ASPECT;
    });

    state.rows = justify(aspects, this.width, { target: TARGET_HEIGHT, gap: GAP });
    state.height =
      state.rows.reduce((sum, row) => sum + row.height, 0) +
      GAP * Math.max(0, state.rows.length - 1);
    state.body.style.height = `${state.height}px`;
  }

  private mount(state: SectionState): void {
    if (state.mounted) return;
    state.mounted = true;
    this.paint(state);
  }

  private unmount(state: SectionState): void {
    if (!state.mounted) return;
    state.mounted = false;
    // The height stays set, so scroll position survives the round trip.
    state.body.replaceChildren();
  }

  private paint(state: SectionState): void {
    const fragment = document.createDocumentFragment();

    for (const row of state.rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "row";
      rowEl.style.height = `${row.height}px`;
      rowEl.style.gap = `${GAP}px`;

      for (const tile of row.tiles) {
        const item = state.section.items[tile.index];
        if (!item) continue;
        rowEl.append(this.tile(item, tile.w, tile.h, state, tile.index));
      }
      fragment.append(rowEl);
    }

    state.body.replaceChildren(fragment);
  }

  private tile(
    item: Item,
    w: number,
    h: number,
    state: SectionState,
    indexInSection: number,
  ): HTMLElement {
    const button = document.createElement("button");
    button.className = item.kind === "video" ? "tile tile-video" : "tile";
    button.type = "button";
    button.style.width = `${w}px`;
    button.style.height = `${h}px`;
    button.setAttribute("aria-label", item.key);
    button.dataset.key = item.key;
    if (this.selected.has(item.key)) button.classList.add("selected");

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";

    let retried = false;
    img.addEventListener("load", () => {
      button.classList.add("loaded");
      this.measured(state, item.key, img.naturalWidth, img.naturalHeight);
    });
    img.addEventListener("error", () => {
      // Most likely an expired signature; re-sign once before giving up.
      if (retried) {
        button.classList.add("broken");
        return;
      }
      retried = true;
      this.thumbUrls.delete(item.key);
      void this.setThumb(img, item);
    });

    void this.setThumb(img, item);

    // A span, not a checkbox: the tile is already a <button>, and nesting
    // one interactive control inside another is invalid HTML. The click is
    // read off the target instead.
    const check = document.createElement("span");
    check.className = "tile-check";
    check.setAttribute("aria-hidden", "true");

    button.append(img, check);
    button.addEventListener("click", (event) => {
      const flat = state.startIndex + indexInSection;
      const onCheck = (event.target as HTMLElement).closest(".tile-check") !== null;

      if (!onCheck && !this.selecting) {
        this.options.onOpen(flat);
        return;
      }
      if (event.shiftKey && this.anchor !== null) {
        this.selectRange(this.anchor, flat);
        return;
      }
      this.toggle(item.key);
      this.anchor = this.selected.size === 0 ? null : flat;
    });
    return button;
  }

  private async setThumb(img: HTMLImageElement, item: Item): Promise<void> {
    let url = this.thumbUrls.get(item.key);
    if (!url) {
      url = thumbUrl(this.options.creds, item.key);
      this.thumbUrls.set(item.key, url);
    }
    img.src = await url;
  }

  /**
   * A real aspect ratio arrived. Reflow is confined to this one date, so
   * nothing shifts under the cursor, and once measured it never recurs.
   */
  private measured(state: SectionState, key: string, w: number, h: number): void {
    const before = this.options.meta.get(key);
    this.options.meta.observe(key, w, h);
    if (before && before.w === w && before.h === h) return;

    this.dirty.add(state);
    if (this.frame) return;

    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const sections = [...this.dirty];
      this.dirty.clear();
      for (const section of sections) {
        this.relayout(section);
        if (section.mounted) this.paint(section);
      }
    });
  }
}

/** Group items into date sections, newest first. */
export function toSections(items: Item[], label: (date: string) => string): Section[] {
  const byDate = new Map<string, Item[]>();
  for (const item of items) {
    let bucket = byDate.get(item.date);
    if (!bucket) byDate.set(item.date, (bucket = []));
    bucket.push(item);
  }

  return [...byDate.keys()]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((date) => ({
      date,
      label: label(date),
      items: byDate.get(date)!.sort((a, b) => (a.key < b.key ? 1 : -1)),
    }));
}
