/**
 * The year timeline down the right edge, plus a draggable scroll thumb.
 *
 * Everything here is measured in pixel offsets within the scroller, so the
 * year labels and the thumb always agree with each other and with real
 * scroll position. Offsets are recomputed only when the scroll height
 * actually changes, which keeps scrolling free of layout thrash.
 */
import { monthLabel, yearOf } from "./keys";

/** What the rail needs from the grid. Grid satisfies this. */
export interface Timeline {
  yearAnchors(): Array<{ year: string; top: number }>;
  dateAtOffset(top: number): string | undefined;
}

export interface RailOptions {
  root: HTMLElement;
  scroller: HTMLElement;
  /** The scrolling content, watched so label positions follow reflow. */
  content: HTMLElement;
  timeline: Timeline;
}

const THUMB_H = 44;
/** Smallest vertical distance between two year labels before they collide. */
const MIN_LABEL_GAP = 22;

/**
 * Nudge label positions apart so none overprint, keeping them ordered and
 * inside the rail. Two passes: push down to open up the minimum gap, then
 * pull back up anything that ran off the bottom.
 *
 * Pure so it can be tested without a DOM.
 */
export function spaceOut(
  wanted: readonly number[],
  minGap: number,
  height: number,
): number[] {
  const ys = [...wanted];
  if (ys.length === 0) return ys;

  // A short window may not fit every year at the preferred gap. Tighten it
  // rather than let the upward pass shove labels off the top of the rail.
  const margin = minGap / 2;
  const room = Math.max(0, height - margin * 2);
  const gap = ys.length > 1 ? Math.min(minGap, room / (ys.length - 1)) : minGap;

  for (let i = 1; i < ys.length; i++) {
    ys[i] = Math.max(ys[i]!, ys[i - 1]! + gap);
  }

  let ceiling = height - margin;
  for (let i = ys.length - 1; i >= 0; i--) {
    ys[i] = Math.min(ys[i]!, ceiling);
    ceiling = ys[i]! - gap;
  }

  return ys;
}

/**
 * Where to sample the timeline for "which date am I looking at".
 *
 * Sampling the viewport's top edge never reaches sections shorter than the
 * viewport that sit at the end of the list: scrollHeight - clientHeight
 * stops short of their offsetTop, so they can never be scrolled to the top
 * and stay permanently unreported.
 *
 * So slide the probe from the top edge to the bottom edge as scrolling
 * approaches the end. At rest at the top it reads the first section; at the
 * very bottom it reads the last. This also matches the thumb, which uses
 * the same fraction.
 */
export function probeOffset(
  fraction: number,
  maxScroll: number,
  viewportHeight: number,
): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  return clamped * maxScroll + clamped * viewportHeight;
}

export class Rail {
  private labels = new Map<string, HTMLButtonElement>();
  private thumb: HTMLElement;
  private bubble: HTMLElement;
  private active: string | undefined;
  private dragging = false;
  /** Scroll height the current label positions were computed against. */
  private measuredAt = -1;
  private resize: ResizeObserver;

  constructor(private readonly options: RailOptions) {
    const { root } = options;
    root.classList.add("rail");

    this.thumb = document.createElement("div");
    this.thumb.className = "rail-thumb";
    this.thumb.setAttribute("role", "scrollbar");
    this.thumb.setAttribute("aria-label", "Scroll through time");
    this.thumb.innerHTML = `<span class="rail-arrow up"></span><span class="rail-arrow down"></span>`;

    this.bubble = document.createElement("div");
    this.bubble.className = "rail-bubble";
    this.bubble.hidden = true;

    // Thumbnails loading changes section heights, which moves every label.
    this.resize = new ResizeObserver(() => this.sync());
    this.resize.observe(options.content);

    this.thumb.addEventListener("pointerdown", this.onPointerDown);
    root.addEventListener("pointermove", this.onPointerMove);
    root.addEventListener("pointerup", this.onPointerUp);
    root.addEventListener("pointercancel", this.onPointerUp);
  }

  setYears(years: string[]): void {
    this.labels.clear();
    const fragment = document.createDocumentFragment();

    for (const year of years) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "rail-year";
      el.textContent = year;
      el.addEventListener("click", () => this.scrollToYear(year));
      this.labels.set(year, el);
      fragment.append(el);
    }

    fragment.append(this.bubble, this.thumb);
    this.options.root.replaceChildren(fragment);
    this.measuredAt = -1;
    this.sync();
  }

  /** Reposition thumb and labels. Called from the scroll handler. */
  sync(): void {
    const { scroller } = this.options;
    const max = this.maxScroll();

    if (scroller.scrollHeight !== this.measuredAt) {
      this.placeLabels(max);
      this.measuredAt = scroller.scrollHeight;
    }

    const fraction = max > 0 ? scroller.scrollTop / max : 0;
    this.thumb.style.top = `${this.railY(fraction) - THUMB_H / 2}px`;

    if (!this.dragging) this.setActive(this.dateAt(fraction));
  }

  destroy(): void {
    this.resize.disconnect();
    this.options.root.replaceChildren();
  }

  /* ------------------------------------------------------------ layout */

  private maxScroll(): number {
    const { scroller } = this.options;
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }

  /**
   * Scroll fraction to a Y within the rail. Insetting by half the thumb at
   * each end keeps the thumb fully on screen at both extremes, and the year
   * labels use the same mapping so they line up with it.
   */
  private railY(fraction: number): number {
    const height = this.options.root.clientHeight;
    const usable = Math.max(0, height - THUMB_H);
    return THUMB_H / 2 + Math.min(1, Math.max(0, fraction)) * usable;
  }

  /**
   * Place the year labels, nudging them apart where they would collide.
   *
   * A year holding a handful of photos spans almost no scroll range, so
   * several sparse years land on the same pixel and overprint into an
   * unreadable smudge. Labels are navigation affordances rather than
   * position readouts -- the thumb is the readout -- so it is better to
   * spread them and keep every year clickable than to drop some. Clicking
   * still jumps to the real anchor, not to where the label was drawn.
   */
  private placeLabels(max: number): void {
    const anchors = this.options.timeline.yearAnchors();
    const wanted = anchors.map(({ top }) => this.railY(max > 0 ? top / max : 0));
    const ys = spaceOut(wanted, MIN_LABEL_GAP, this.options.root.clientHeight);

    anchors.forEach(({ year }, i) => {
      const el = this.labels.get(year);
      if (el) el.style.top = `${ys[i]}px`;
    });
  }

  /** Date under the thumb at a given scroll fraction. */
  private dateAt(fraction: number): string | undefined {
    const probe = probeOffset(fraction, this.maxScroll(), this.options.scroller.clientHeight);
    return this.options.timeline.dateAtOffset(probe);
  }

  private setActive(date: string | undefined): void {
    const year = date ? yearOf(date) : undefined;
    if (year !== this.active) {
      this.active = year;
      for (const [name, el] of this.labels) el.classList.toggle("active", name === year);
    }
    if (date) this.bubble.textContent = monthLabel(date);
  }

  private scrollToYear(year: string): void {
    const anchor = this.options.timeline.yearAnchors().find((a) => a.year === year);
    if (anchor) this.options.scroller.scrollTo({ top: anchor.top });
  }

  /* ----------------------------------------------------------- dragging */

  private onPointerDown = (event: PointerEvent): void => {
    this.dragging = true;
    this.options.root.setPointerCapture(event.pointerId);
    this.bubble.hidden = false;
    this.thumb.classList.add("dragging");
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;

    const box = this.options.root.getBoundingClientRect();
    const usable = Math.max(1, box.height - THUMB_H);
    const fraction = (event.clientY - box.top - THUMB_H / 2) / usable;
    const clamped = Math.min(1, Math.max(0, fraction));

    this.options.scroller.scrollTop = clamped * this.maxScroll();

    this.thumb.style.top = `${this.railY(clamped) - THUMB_H / 2}px`;
    this.bubble.style.top = `${this.railY(clamped)}px`;
    this.setActive(this.dateAt(clamped));
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.bubble.hidden = true;
    this.thumb.classList.remove("dragging");
    if (this.options.root.hasPointerCapture(event.pointerId)) {
      this.options.root.releasePointerCapture(event.pointerId);
    }
  };
}
