/**
 * Wiring: credentials, listing, and the three screens (setup, gallery,
 * failure). Cached manifest paints immediately; a re-list runs behind it.
 */
import { clearCreds, getCreds, getManifest, nuke, putCreds, putManifest } from "./db";
import { Grid, toSections } from "./grid";
import { dateLabel } from "./keys";
import { Lightbox } from "./lightbox";
import { MeasuredProvider } from "./meta";
import { Rail } from "./rail";
import { deleteItems, listAll, NetworkError, S3Error, verify } from "./s3api";
import { presignGet } from "./sigv4";
import { embedQuery, clearGoogleCaches, translateQuery } from "./search/google";
import { searchNominatim } from "./search/nominatim";
import { runSearch, suggestFor } from "./search/search";
import { getSnapshot, loadApiKey, loadEmbeddings, loadIndex, saveImport } from "./search/store";
import type { SearchDeps } from "./search/search";
import type { SearchIndex } from "./search/local";
import type { ImportResult } from "./search/import";
import type { Creds, Item } from "./types";

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const screens = {
  setup: () => el("setup"),
  gallery: () => el("gallery"),
  failure: () => el("failure"),
};

function show(name: keyof typeof screens): void {
  for (const [key, get] of Object.entries(screens)) {
    get().hidden = key !== name;
  }
}

function status(message: string, busy = false): void {
  const bar = el("status");
  bar.textContent = message;
  bar.classList.toggle("busy", busy);
  bar.hidden = message === "";
}

void start();

async function start(): Promise<void> {
  if (!globalThis.crypto?.subtle) {
    fail(
      "This page needs Web Crypto",
      "crypto.subtle is only available in a secure context. Serve the page over http://localhost or https rather than opening the file directly.",
    );
    return;
  }

  let creds: Creds | null;
  try {
    creds = await getCreds();
  } catch (error) {
    // Notably: a blocked IndexedDB version upgrade (another tab has this app
    // open) rejects here rather than hanging with no screen shown at all.
    fail("Could not open local storage", explain(error));
    return;
  }
  if (creds) void boot(creds);
  else showSetup();
}

/* ---------------------------------------------------------------- setup */

function showSetup(prefill?: Creds, message?: string): void {
  show("setup");
  const form = el<HTMLFormElement>("setup-form");

  if (prefill) {
    for (const [name, value] of Object.entries(prefill)) {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        field.value = String(value ?? "");
      }
    }
  }

  const note = el("setup-error");
  note.textContent = message ?? "";
  note.hidden = !message;

  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const creds: Creds = {
      endpoint: String(data.get("endpoint") ?? "").trim(),
      region: String(data.get("region") ?? "").trim(),
      bucket: String(data.get("bucket") ?? "").trim(),
      accessKey: String(data.get("accessKey") ?? "").trim(),
      secretKey: String(data.get("secretKey") ?? "").trim(),
      sessionToken: String(data.get("sessionToken") ?? "").trim() || undefined,
      googleApiKey: String(data.get("googleApiKey") ?? "").trim() || undefined,
    };

    const button = el<HTMLButtonElement>("setup-submit");
    button.disabled = true;
    note.hidden = true;

    try {
      await verify(creds);
      await putCreds(creds);
      void boot(creds);
    } catch (error) {
      button.disabled = false;
      note.textContent = explain(error);
      note.hidden = false;
    }
  };
}

/* -------------------------------------------------------------- gallery */

async function boot(creds: Creds): Promise<void> {
  show("gallery");
  status("Loading…", true);

  const meta = await MeasuredProvider.load();
  const scroller = el("scroller");

  const lightbox = new Lightbox({
    root: el("lightbox"),
    creds,
    onDelete: (item) => removePhotos([item.key]),
  });

  const grid = new Grid({
    container: el("grid"),
    scroller,
    creds,
    meta,
    onOpen: (index) => lightbox.show(index),
    onSelectionChange: (count) => {
      el("selbar").hidden = count === 0;
      el("selbar-count").textContent = `${count} selected`;
    },
  });

  const rail = new Rail({
    root: el("rail"),
    scroller,
    content: el("grid"),
    timeline: grid,
  });

  /** The full library, as last rendered. Search filters this, never replaces it. */
  let library: Item[] = [];
  /** What the grid is showing right now: the library, or a search's matches. */
  let view: Item[] = [];

  const render = (items: Item[]): void => {
    view = items;
    const sections = toSections(items, dateLabel);
    grid.setSections(sections);
    rail.setYears([...new Set(sections.map((s) => s.date.slice(0, 4)))]);
    lightbox.setItems(grid.items);
  };

  /** Renders a fresh listing and remembers it as the library. */
  const renderLibrary = (items: Item[]): void => {
    library = items;
    render(items);
    status(
      items.length === 0
        ? "No photos found. Expected keys shaped like 2022/08/29/IMG_1234.jpg"
        : "",
    );
  };

  /**
   * Deletes photos from the bucket, then from the library. Resolves true if
   * anything actually went.
   *
   * The bucket is the source of truth, so only keys S3 confirmed are dropped
   * locally. Nothing here touches the search snapshot: that database belongs
   * to the phone app, which drops rows whose object has gone.
   */
  const removePhotos = async (keys: string[]): Promise<boolean> => {
    if (keys.length === 0) return false;
    const what = keys.length === 1 ? "1 photo" : `${keys.length} photos`;
    if (!confirm(`Delete ${what} from the bucket? This cannot be undone.`)) return false;

    status(`Deleting ${what}…`, true);
    const result = await deleteItems(creds, keys, {
      onProgress: (done, total) => status(`Deleting ${done} of ${total}…`, true),
    });

    const gone = new Set(result.deleted);
    if (gone.size > 0) {
      library = library.filter((item) => !gone.has(item.key));
      // Repaint before persisting: the objects are already gone either way,
      // so a failed cache write must not leave them on screen.
      render(view.filter((item) => !gone.has(item.key)));
      // A stale cache self-heals -- the next boot's listing won't contain
      // these keys, and `changed()` rewrites the manifest then.
      await putManifest(library).catch(() => {});
    }

    const failure = result.failed[0];
    status(
      failure === undefined
        ? ""
        : `Deleted ${gone.size} of ${keys.length}. ${failure.key}: ${explain(failure.error)}`,
    );
    return gone.size > 0;
  };

  el("selbar-clear").onclick = () => grid.clearSelection();
  el("selbar-delete").onclick = () => void removePhotos(grid.selection);

  let ticking = false;
  scroller.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        rail.sync();
      });
    },
    { passive: true },
  );

  el("forget").onclick = async () => {
    if (!confirm("Forget credentials and delete the local cache?")) return;
    clearGoogleCaches();
    await clearCreds();
    await nuke();
    location.reload();
  };

  // Paint whatever we already know, then reconcile with the bucket.
  const cached = await getManifest();
  const hadCache = cached.length > 0;
  if (hadCache) renderLibrary(cached);

  try {
    const fresh = await listAll(creds, ({ pages, items }) => {
      if (!hadCache) status(`Listing bucket… ${items} items across ${pages} pages`, true);
    });

    if (changed(cached, fresh)) {
      await putManifest(fresh);
      renderLibrary(fresh);
    } else if (!hadCache) {
      renderLibrary(fresh);
    }
  } catch (error) {
    if (hadCache) status(`Showing cached library — refresh failed: ${explain(error)}`);
    else failFrom(error, creds);
  }

  // The one index read of the page: the search box needs it to decide
  // whether to show itself, and the boot sequence needs to know whether one
  // exists. Reusing the promise keeps that to a single deserialization.
  const searchIndex = wireSearch(creds, () => library, render);

  // A stored `lastModified` with no searchable index behind it -- the
  // pre-migration index format, or a record lost while the snapshot marker
  // survived -- counts as nothing stored. Without this the unchanged remote
  // `lastModified` would equal the stale local one and the re-import the new
  // format needs would never fire.
  const [remote, marker, index] = await Promise.all([
    remoteSnapshot(creds),
    getSnapshot(),
    searchIndex,
  ]);
  const local = index !== null ? marker : null;
  if (remote !== null && remote !== local) {
    status("Importing search index…", true);
    const url = await presignGet({ creds, key: SNAPSHOT_KEY });
    const result = await importSnapshot(url, (loaded, total) => {
      const mb = (bytes: number): string => (bytes / 1e6).toFixed(1);
      status(total > 0 ? `Importing search index… ${mb(loaded)}/${mb(total)} MB` : `Importing search index… ${mb(loaded)} MB`, true);
    });
    if (result === null) {
      status(
        local === null
          ? "Search index could not be built — search is unavailable this session."
          : "Search index could not be updated — searching the previous snapshot.",
      );
    } else {
      await saveImport(result, remote);
      status("");
      location.reload();
    }
  }
}

const STATUS_KEY = ".meta/db-status.json";
const SNAPSHOT_KEY = ".meta/s3immich.db.gz";

/**
 * The snapshot's `lastModified`, or null when the bucket has none.
 *
 * A locale-independent status file exists precisely so this comparison does
 * not depend on parsing a Last-Modified header.
 */
async function remoteSnapshot(creds: Creds): Promise<number | null> {
  try {
    const response = await fetch(await presignGet({ creds, key: STATUS_KEY }));
    if (!response.ok) return null;
    const body = (await response.json()) as { lastModified?: unknown };
    return typeof body.lastModified === "number" ? body.lastModified : null;
  } catch {
    return null;
  }
}

/**
 * Imports the snapshot in a Worker. Resolves to the result, or null on any
 * failure -- the caller keeps whatever index it already had.
 */
function importSnapshot(url: string, onProgress: (loaded: number, total: number) => void): Promise<ImportResult | null> {
  return new Promise((resolve) => {
    const worker = new Worker("search-worker.js");
    const finish = (result: ImportResult | null): void => {
      worker.terminate();
      resolve(result);
    };
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as
        | { type: "progress"; loaded: number; total: number }
        | { type: "done"; result: ImportResult }
        | { type: "error"; message: string };
      if (message.type === "progress") onProgress(message.loaded, message.total);
      else if (message.type === "done") finish(message.result);
      else finish(null);
    };
    worker.onerror = () => finish(null);
    worker.postMessage({ url });
  });
}

/**
 * The search box. Fires on Enter only -- matching the reference app, and
 * keeping Nominatim to one request per deliberate search, comfortably inside
 * their fair-use policy.
 *
 * Returns the one `loadIndex()` this page performs, so the boot sequence can
 * decide whether an import is needed off the same read rather than
 * deserializing the whole index a second time.
 */
function wireSearch(
  creds: Creds,
  getItems: () => Item[],
  render: (items: Item[]) => void,
): Promise<SearchIndex | null> {
  const form = el<HTMLFormElement>("search-form");
  const input = el<HTMLInputElement>("search-input");
  const clear = el<HTMLButtonElement>("search-clear");
  const summary = el("search-summary");
  const chips = el("search-chips");

  let index: SearchIndex | null = null;
  const loading = loadIndex().then((loaded) => {
    index = loaded;
    form.hidden = loaded === null;
    return loaded;
  });
  form.hidden = true;

  const showChips = (suggestions: Array<{ display: string; query: string }>): void => {
    chips.replaceChildren();
    for (const suggestion of suggestions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = suggestion.display;
      button.onclick = () => {
        input.value = suggestion.query;
        form.requestSubmit();
      };
      chips.append(button);
    }
    chips.hidden = suggestions.length === 0;
  };

  // Bumped on every submit and on every clear. A search checks its own token
  // before touching the DOM at each step, so a stale response -- the network
  // passes below are capped at 3 s but not cancelled, so a superseded search
  // just runs to completion and is discarded -- loses the race instead of
  // overwriting a newer search or a cleared box.
  let generation = 0;

  const reset = (): void => {
    generation++;
    input.value = "";
    clear.hidden = true;
    summary.hidden = true;
    chips.hidden = true;
    chips.replaceChildren();
    render(getItems());
  };

  clear.onclick = reset;

  form.onsubmit = async (event) => {
    event.preventDefault();
    const mine = ++generation;
    const query = input.value.trim();
    if (query === "" || index === null) {
      reset();
      return;
    }

    clear.hidden = false;
    chips.hidden = true;
    summary.hidden = false;
    summary.textContent = "Searching…";

    try {
      const apiKey = creds.googleApiKey ?? (await loadApiKey());
      const deps: SearchDeps = {
        index,
        items: getItems(),
        translate: (q) => (apiKey === null ? Promise.resolve(null) : translateQuery(q, apiKey)),
        embed: (q) => (apiKey === null ? Promise.resolve(null) : embedQuery(q, apiKey)),
        places: (q, options) => searchNominatim(q, options),
        embeddings: loadEmbeddings,
      };

      const keys = await runSearch(query, deps);
      if (mine !== generation) return;
      // Filter the manifest rather than the result set, so the grid keeps the
      // reverse-chronological order it already has.
      const matches = getItems().filter((item) => keys.has(item.key));
      render(matches);

      if (matches.length > 0) {
        summary.textContent = `${matches.length} ${matches.length === 1 ? "match" : "matches"} for “${query}”`;
        showChips([]);
        return;
      }

      summary.textContent = `No matches for “${query}”`;
      const suggestions = await suggestFor(query, deps);
      if (mine !== generation) return;
      showChips(suggestions);
    } catch (error) {
      if (mine !== generation) return;
      summary.textContent = `Search failed: ${explain(error)}`;
      showChips([]);
    }
  };

  return loading;
}

/** Cheap comparison: count plus a key-order digest. */
function changed(a: Item[], b: Item[]): boolean {
  if (a.length !== b.length) return true;
  const left = a.map((i) => i.key).sort();
  const right = b.map((i) => i.key).sort();
  return left.some((key, i) => key !== right[i]);
}

/* -------------------------------------------------------------- failure */

function failFrom(error: unknown, creds?: Creds): void {
  if (error instanceof NetworkError) {
    fail("Could not reach the bucket", corsHelp(), true);
    return;
  }
  if (error instanceof S3Error) {
    switch (error.code) {
      case "SignatureDoesNotMatch":
        showSetup(creds, "Signature rejected. The region is the usual cause — a wrong region looks exactly like a wrong secret key.");
        return;
      case "AccessDenied":
        showSetup(creds, "Access denied. The key is missing s3:ListBucket on this bucket.");
        return;
      case "NoSuchBucket":
        showSetup(creds, "No such bucket. Check the bucket name and the endpoint region match.");
        return;
      case "RequestTimeTooSkewed":
        fail("Your clock is wrong", "S3 rejected the signature because this machine's clock has drifted more than 15 minutes from real time. Fix the system clock and reload.");
        return;
      default:
        showSetup(creds, `${error.code}: ${error.message}`);
        return;
    }
  }
  fail("Something went wrong", String(error));
}

function fail(title: string, detail: string, asHtml = false): void {
  show("failure");
  el("failure-title").textContent = title;
  const body = el("failure-detail");
  if (asHtml) body.innerHTML = detail;
  else body.textContent = detail;
}

/**
 * A failed fetch cannot tell CORS from a dead network, so say both rather
 * than guessing.
 */
function corsHelp(): string {
  const origin = location.origin;
  const rule = JSON.stringify(
    [{ AllowedOrigins: [origin], AllowedMethods: ["GET", "HEAD"], AllowedHeaders: ["*"], MaxAgeSeconds: 3000 }],
    null,
    2,
  );
  return `
    <p>The request never completed. Two things look identical from here:</p>
    <ol>
      <li>The network or endpoint is unreachable.</li>
      <li>The bucket has no CORS rule allowing this origin. Listing is a
          <code>fetch</code>, so it needs one — images and video do not.</li>
    </ol>
    <p>If it is CORS, add this to the bucket's CORS configuration:</p>
    <pre><code>${escapeHtml(rule)}</code></pre>
    <p>Origin: <code>${escapeHtml(origin)}</code></p>
    <p><button type="button" onclick="location.reload()">Retry</button></p>
  `;
}

function explain(error: unknown): string {
  if (error instanceof S3Error) return `${error.code}: ${error.message}`;
  if (error instanceof NetworkError) {
    return "Could not reach the bucket. Check the endpoint, and that the bucket allows this origin via CORS.";
  }
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}
