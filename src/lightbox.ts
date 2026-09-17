/**
 * Full-resolution viewer.
 *
 * This is the ONE place the file extension decides anything: .mp4 gets a
 * <video>, everything else an <img>. Thumbnails never consult it — they are
 * always JPEG whatever their key says.
 */
import { originalUrl } from "./s3api";
import type { Creds, Item } from "./types";

export interface LightboxOptions {
  root: HTMLElement;
  creds: Creds;
  /**
   * Deletes the shown photo. Resolves true once it is gone, by which time
   * the caller is expected to have pushed a shorter list in via setItems.
   */
  onDelete?: (item: Item) => Promise<boolean>;
}

export class Lightbox {
  private items: Item[] = [];
  private index = 0;
  private open = false;
  private stage: HTMLElement;
  private caption: HTMLElement;
  /** Guards against a slow load from an earlier item overwriting a newer one. */
  private token = 0;
  /** A held Delete key must not queue a second delete behind the first. */
  private busy = false;

  constructor(private readonly options: LightboxOptions) {
    const { root } = options;
    root.className = "lightbox";
    root.hidden = true;
    root.tabIndex = -1;

    root.innerHTML = `
      <button class="lb-close" type="button" aria-label="Close">&times;</button>
      <button class="lb-delete" type="button" aria-label="Delete">&#128465;&#xFE0E;</button>
      <button class="lb-nav lb-prev" type="button" aria-label="Previous">&#8249;</button>
      <div class="lb-stage"></div>
      <button class="lb-nav lb-next" type="button" aria-label="Next">&#8250;</button>
      <div class="lb-caption"></div>
    `;

    this.stage = root.querySelector(".lb-stage")!;
    this.caption = root.querySelector(".lb-caption")!;

    root.querySelector(".lb-close")!.addEventListener("click", () => this.close());

    const trash = root.querySelector<HTMLElement>(".lb-delete")!;
    trash.hidden = options.onDelete === undefined;
    trash.addEventListener("click", () => void this.remove());
    root.querySelector(".lb-prev")!.addEventListener("click", () => this.step(-1));
    root.querySelector(".lb-next")!.addEventListener("click", () => this.step(1));
    root.addEventListener("click", (event) => {
      if (event.target === root) this.close();
    });

    document.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("popstate", this.onPopState);
  }

  setItems(items: Item[]): void {
    this.items = items;
  }

  /**
   * Pushes a history entry the first time the lightbox opens over the
   * timeline, so the browser's back button -- and the mouse's back button,
   * which the browser treats as the same navigation -- closes the viewer and
   * lands back on the timeline at its current scroll position instead of
   * leaving the page entirely.
   */
  show(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    const wasOpen = this.open;
    this.index = index;
    this.open = true;
    this.options.root.hidden = false;
    document.body.classList.add("lb-open");
    this.options.root.focus();
    if (!wasOpen) history.pushState({ lightbox: true }, "");
    void this.render();
  }

  close(): void {
    this.closeView();
    // Pop the entry show() pushed, so back/forward stays in sync with what's
    // on screen. This re-enters via onPopState, which is a no-op because
    // `open` is already false.
    if (history.state?.lightbox) history.back();
  }

  private closeView(): void {
    if (!this.open) return;
    this.open = false;
    this.token++;
    this.options.root.hidden = true;
    document.body.classList.remove("lb-open");
    // Stops playback and releases the connection.
    this.stage.replaceChildren();
  }

  destroy(): void {
    document.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("popstate", this.onPopState);
  }

  private onPopState = (): void => {
    this.closeView();
  };

  /**
   * Deletes what is on screen, then shows whatever moved up into its place.
   *
   * The caller's re-render replaces `items` with a shorter list, so the same
   * index now addresses the NEXT photo -- which is what deleting from a
   * viewer should leave you looking at. Clamped for the last photo, closed
   * when nothing is left.
   */
  private async remove(): Promise<void> {
    const item = this.items[this.index];
    if (!this.open || !item || this.busy) return;
    const onDelete = this.options.onDelete;
    if (!onDelete) return;

    this.busy = true;
    let gone: boolean;
    try {
      gone = await onDelete(item);
    } finally {
      this.busy = false;
    }
    if (!gone || !this.open) return;

    if (this.items.length === 0) {
      this.close();
      return;
    }
    this.show(Math.min(this.index, this.items.length - 1));
  }

  private step(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.items.length) return;
    this.index = next;
    void this.render();
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.open) return;
    if (event.key === "Escape" || event.key === "Backspace") this.close();
    else if (event.key === "ArrowLeft") this.step(-1);
    else if (event.key === "ArrowRight") this.step(1);
    else if (event.key === "Delete") void this.remove();
    else return;
    event.preventDefault();
  };

  private async render(): Promise<void> {
    const item = this.items[this.index];
    if (!item) return;

    const mine = ++this.token;
    this.caption.textContent = `${item.key} — ${this.index + 1} of ${this.items.length}`;
    this.stage.replaceChildren(spinner());

    const url = await originalUrl(this.options.creds, item.key);
    if (mine !== this.token) return;

    const media =
      item.kind === "video" ? videoElement(url) : imageElement(url, item.key);
    this.stage.replaceChildren(media);
  }
}

function imageElement(url: string, key: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "lb-media";
  img.decoding = "async";
  img.alt = key;
  img.src = url;
  return img;
}

function videoElement(url: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.className = "lb-media";
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  video.src = url;
  return video;
}

function spinner(): HTMLElement {
  const el = document.createElement("div");
  el.className = "lb-spinner";
  return el;
}
