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
}

export class Lightbox {
  private items: Item[] = [];
  private index = 0;
  private open = false;
  private stage: HTMLElement;
  private caption: HTMLElement;
  /** Guards against a slow load from an earlier item overwriting a newer one. */
  private token = 0;

  constructor(private readonly options: LightboxOptions) {
    const { root } = options;
    root.className = "lightbox";
    root.hidden = true;
    root.tabIndex = -1;

    root.innerHTML = `
      <button class="lb-close" type="button" aria-label="Close">&times;</button>
      <button class="lb-nav lb-prev" type="button" aria-label="Previous">&#8249;</button>
      <div class="lb-stage"></div>
      <button class="lb-nav lb-next" type="button" aria-label="Next">&#8250;</button>
      <div class="lb-caption"></div>
    `;

    this.stage = root.querySelector(".lb-stage")!;
    this.caption = root.querySelector(".lb-caption")!;

    root.querySelector(".lb-close")!.addEventListener("click", () => this.close());
    root.querySelector(".lb-prev")!.addEventListener("click", () => this.step(-1));
    root.querySelector(".lb-next")!.addEventListener("click", () => this.step(1));
    root.addEventListener("click", (event) => {
      if (event.target === root) this.close();
    });

    document.addEventListener("keydown", this.onKeyDown);
  }

  setItems(items: Item[]): void {
    this.items = items;
  }

  show(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    this.index = index;
    this.open = true;
    this.options.root.hidden = false;
    document.body.classList.add("lb-open");
    this.options.root.focus();
    void this.render();
  }

  close(): void {
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
  }

  private step(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.items.length) return;
    this.index = next;
    void this.render();
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.open) return;
    if (event.key === "Escape") this.close();
    else if (event.key === "ArrowLeft") this.step(-1);
    else if (event.key === "ArrowRight") this.step(1);
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
