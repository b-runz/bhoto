// src/db.ts
var DB_NAME = "s3photos";
var VERSION = 2;
var CREDS_KEY = "current";
var open;
function db() {
  open ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("creds"))
        d.createObjectStore("creds");
      if (!d.objectStoreNames.contains("manifest"))
        d.createObjectStore("manifest", { keyPath: "key" });
      if (!d.objectStoreNames.contains("meta"))
        d.createObjectStore("meta");
      if (!d.objectStoreNames.contains("search"))
        d.createObjectStore("search");
    };
    req.onblocked = () => reject(new Error("Another tab has this app open with an older version. Close other tabs of this app and reload."));
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => d.close();
      resolve(d);
    };
    req.onerror = () => reject(req.error);
  });
  return open;
}
function run(store, mode, body) {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = body(tx.objectStore(store));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => resolve(req ? req.result : undefined);
  }));
}
async function getCreds() {
  const value = await run("creds", "readonly", (s) => s.get(CREDS_KEY));
  return value ?? null;
}
function putCreds(creds) {
  return run("creds", "readwrite", (s) => s.put(creds, CREDS_KEY));
}
function clearCreds() {
  return run("creds", "readwrite", (s) => s.delete(CREDS_KEY));
}
async function getManifest() {
  return await run("manifest", "readonly", (s) => s.getAll()) ?? [];
}
async function putManifest(items) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const tx = d.transaction("manifest", "readwrite");
    const store = tx.objectStore("manifest");
    store.clear();
    for (const item of items)
      store.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function getAllMeta() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("meta", "readonly");
    const store = tx.objectStore("meta");
    const keys = store.getAllKeys();
    const values = store.getAll();
    tx.oncomplete = () => {
      const out = new Map;
      const k = keys.result;
      const v = values.result;
      for (let i = 0;i < k.length; i++)
        out.set(String(k[i]), v[i]);
      resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  });
}
async function putMetaBatch(entries) {
  const list = [...entries];
  if (list.length === 0)
    return;
  const d = await db();
  await new Promise((resolve, reject) => {
    const tx = d.transaction("meta", "readwrite");
    const store = tx.objectStore("meta");
    for (const [key, value] of list)
      store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function getSearch(key) {
  return run("search", "readonly", (s) => s.get(key));
}
async function putSearchAll(entries) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const tx = d.transaction("search", "readwrite");
    const store = tx.objectStore("search");
    for (const [key, value] of entries)
      store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function nuke() {
  open = undefined;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

// src/justify.ts
var DEFAULT_ASPECT = 3 / 2;
function justify(aspects, containerWidth, options = {}) {
  const target = options.target ?? 200;
  const gap = options.gap ?? 4;
  if (containerWidth <= 0 || aspects.length === 0)
    return [];
  const rows = [];
  let run2 = [];
  let sum = 0;
  const heightFor = (n, aspectSum) => (containerWidth - gap * (n - 1)) / aspectSum;
  for (let i = 0;i < aspects.length; i++) {
    const aspect = safeAspect(aspects[i]);
    const withHeight = heightFor(run2.length + 1, sum + aspect);
    if (run2.length > 0 && withHeight < target) {
      const withoutHeight = heightFor(run2.length, sum);
      if (Math.abs(withoutHeight - target) <= Math.abs(withHeight - target)) {
        rows.push(buildRow(run2, i - run2.length, withoutHeight));
        run2 = [];
        sum = 0;
      }
    }
    run2.push(aspect);
    sum += aspect;
    if (heightFor(run2.length, sum) <= target) {
      rows.push(buildRow(run2, i - run2.length + 1, heightFor(run2.length, sum)));
      run2 = [];
      sum = 0;
    }
  }
  if (run2.length > 0) {
    const height = Math.min(target, heightFor(run2.length, sum));
    rows.push(buildRow(run2, aspects.length - run2.length, height));
  }
  return rows;
}
function buildRow(aspects, startIndex, height) {
  return {
    height,
    tiles: aspects.map((aspect, n) => ({
      w: aspect * height,
      h: height,
      index: startIndex + n
    }))
  };
}
function safeAspect(aspect) {
  return typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
}

// src/keys.ts
var THUMB_PREFIX = ".thumbs/";
var IMAGE_EXT = new Set(["jpg", "jpeg"]);
var VIDEO_EXT = new Set(["mp4"]);
var KEY_RE = /^(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\.([A-Za-z0-9]+)$/;
var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
function thumbKey(key) {
  return THUMB_PREFIX + key;
}
function parseKey(key, bytes) {
  if (key.startsWith(THUMB_PREFIX))
    return null;
  const m = KEY_RE.exec(key);
  if (!m)
    return null;
  const [, yy, mm, dd, , rawExt] = m;
  const ext = rawExt.toLowerCase();
  if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext))
    return null;
  const year = Number(yy), month = Number(mm), day = Number(dd);
  if (!isRealDate(year, month, day))
    return null;
  return {
    key,
    date: `${yy}-${mm}-${dd}`,
    bytes,
    kind: VIDEO_EXT.has(ext) ? "video" : "image"
  };
}
function isRealDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31)
    return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
function dateLabel(date) {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[at.getUTCDay()]}, ${d} ${MONTHS[m - 1]} ${y}`;
}
function monthLabel(date) {
  const [y, m] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
function yearOf(date) {
  return date.slice(0, 4);
}

// src/sigv4.ts
var ALGORITHM = "AWS4-HMAC-SHA256";
var SERVICE = "s3";
var UNSIGNED = "UNSIGNED-PAYLOAD";
var encoder = new TextEncoder;
var signingKeys = new Map;
async function presignGet(options) {
  const { creds, key } = options;
  const expires = options.expires ?? 3600;
  const now = options.now ?? new Date;
  const region = creds.region.trim();
  const host = `${creds.bucket.trim()}.${normaliseEndpoint(creds.endpoint)}`;
  const canonicalUri = "/" + encodePath(key.trim().replace(/^\/+/, ""));
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const params = {
    ...options.query,
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${creds.accessKey.trim()}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host"
  };
  const token = creds.sessionToken?.trim();
  if (token)
    params["X-Amz-Security-Token"] = token;
  const query = canonicalQuery(params);
  const canonicalRequest = [
    "GET",
    canonicalUri,
    query,
    `host:${host}
`,
    "host",
    UNSIGNED
  ].join(`
`);
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    hex(await sha256(canonicalRequest))
  ].join(`
`);
  const signature = hex(await hmac(await signingKey(creds.secretKey, dateStamp, region), stringToSign));
  return `https://${host}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}
function normaliseEndpoint(endpoint) {
  return endpoint.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}
function signingKey(secret, dateStamp, region) {
  const id = `${dateStamp}|${region}|${secret}`;
  let derived = signingKeys.get(id);
  if (!derived) {
    derived = (async () => {
      let k = await hmac(encoder.encode("AWS4" + secret), dateStamp);
      k = await hmac(k, region);
      k = await hmac(k, SERVICE);
      return hmac(k, "aws4_request");
    })();
    signingKeys.set(id, derived);
  }
  return derived;
}
function canonicalQuery(params) {
  return Object.keys(params).sort().map((name) => `${uriEncode(name)}=${uriEncode(params[name])}`).join("&");
}
function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function encodePath(key) {
  return key.split("/").map(uriEncode).join("/");
}
function sha256(input) {
  return crypto.subtle.digest("SHA-256", encoder.encode(input));
}
async function hmac(key, message) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return new Uint8Array(sig);
}
function hex(buffer) {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = "";
  for (const byte of view)
    out += byte.toString(16).padStart(2, "0");
  return out;
}

// src/s3api.ts
var PAGE_SIZE = 1000;

class S3Error extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "S3Error";
  }
}

class NetworkError extends Error {
  cause;
  constructor(cause) {
    super("Could not reach the bucket");
    this.cause = cause;
    this.name = "NetworkError";
  }
}
function thumbUrl(creds, key) {
  return presignGet({
    creds,
    key: thumbKey(key),
    query: { "response-content-type": "image/jpeg" }
  });
}
function originalUrl(creds, key) {
  return presignGet({ creds, key });
}
async function listAll(creds, onProgress, signal) {
  const items = [];
  let token;
  let pages = 0;
  do {
    const doc = await listPage(creds, token, signal);
    pages++;
    for (const node of doc.querySelectorAll("Contents")) {
      const key = text(node, "Key");
      if (!key)
        continue;
      const item = parseKey(key, Number(text(node, "Size") ?? 0));
      if (item)
        items.push(item);
    }
    token = text(doc.documentElement, "NextContinuationToken") ?? undefined;
    onProgress?.({ pages, items: items.length });
  } while (token);
  return items;
}
async function listPage(creds, token, signal, maxKeys = PAGE_SIZE) {
  const query = {
    "list-type": "2",
    "max-keys": String(maxKeys)
  };
  if (token)
    query["continuation-token"] = token;
  const url = await presignGet({ creds, key: "", query, expires: 300 });
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (cause) {
    if (signal?.aborted)
      throw cause;
    throw new NetworkError(cause);
  }
  const body = await response.text();
  const doc = new DOMParser().parseFromString(body, "text/xml");
  if (!response.ok) {
    throw new S3Error(text(doc.documentElement, "Code") ?? String(response.status), text(doc.documentElement, "Message") ?? response.statusText, response.status);
  }
  if (doc.querySelector("parsererror")) {
    throw new S3Error("MalformedResponse", "The bucket returned unreadable XML", response.status);
  }
  return doc;
}
async function verify(creds) {
  await listPage(creds, undefined, undefined, 1);
}
function text(scope, tag) {
  if (!scope)
    return null;
  for (const child of scope.children) {
    if (child.tagName === tag)
      return child.textContent;
  }
  return scope.querySelector(tag)?.textContent ?? null;
}

// src/grid.ts
var TARGET_HEIGHT = 200;
var GAP = 4;
var MOUNT_MARGIN = "200% 0px";

class Grid {
  options;
  states = [];
  width = 0;
  dirty = new Set;
  frame = 0;
  observer;
  resize;
  thumbUrls = new Map;
  constructor(options) {
    this.options = options;
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const state = entry.target._state;
        if (!state)
          continue;
        if (entry.isIntersecting)
          this.mount(state);
        else
          this.unmount(state);
      }
    }, { root: options.scroller, rootMargin: MOUNT_MARGIN });
    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(options.container);
  }
  setSections(sections) {
    this.teardown();
    this.width = this.options.container.clientWidth;
    let flat = 0;
    const fragment = document.createDocumentFragment();
    for (const section of sections) {
      const root = document.createElement("section");
      root.className = "section";
      root.dataset.date = section.date;
      const header = document.createElement("h2");
      header.className = "section-header";
      header.textContent = section.label;
      const body = document.createElement("div");
      body.className = "section-body";
      root.append(header, body);
      fragment.append(root);
      const state = {
        section,
        root,
        body,
        rows: [],
        height: 0,
        startIndex: flat,
        mounted: false
      };
      root._state = state;
      this.relayout(state);
      this.states.push(state);
      this.observer.observe(root);
      flat += section.items.length;
    }
    this.options.container.replaceChildren(fragment);
  }
  get items() {
    return this.states.flatMap((state) => state.section.items);
  }
  yearAnchors() {
    const seen = new Set;
    const out = [];
    for (const state of this.states) {
      const year = yearOf(state.section.date);
      if (seen.has(year))
        continue;
      seen.add(year);
      out.push({ year, top: state.root.offsetTop });
    }
    return out;
  }
  dateAtOffset(top) {
    if (this.states.length === 0)
      return;
    let low = 0;
    let high = this.states.length - 1;
    let best = this.states[0];
    while (low <= high) {
      const mid = low + high >> 1;
      const state = this.states[mid];
      if (state.root.offsetTop <= top) {
        best = state;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best?.section.date;
  }
  destroy() {
    this.teardown();
    this.observer.disconnect();
    this.resize.disconnect();
  }
  teardown() {
    for (const state of this.states)
      this.observer.unobserve(state.root);
    this.states = [];
    this.dirty.clear();
    this.thumbUrls.clear();
  }
  onResize() {
    const width = this.options.container.clientWidth;
    if (width === this.width || width <= 0)
      return;
    this.width = width;
    for (const state of this.states) {
      this.relayout(state);
      if (state.mounted)
        this.paint(state);
    }
  }
  relayout(state) {
    const aspects = state.section.items.map((item) => {
      const meta = this.options.meta.get(item.key);
      return meta && meta.h > 0 ? meta.w / meta.h : DEFAULT_ASPECT;
    });
    state.rows = justify(aspects, this.width, { target: TARGET_HEIGHT, gap: GAP });
    state.height = state.rows.reduce((sum, row) => sum + row.height, 0) + GAP * Math.max(0, state.rows.length - 1);
    state.body.style.height = `${state.height}px`;
  }
  mount(state) {
    if (state.mounted)
      return;
    state.mounted = true;
    this.paint(state);
  }
  unmount(state) {
    if (!state.mounted)
      return;
    state.mounted = false;
    state.body.replaceChildren();
  }
  paint(state) {
    const fragment = document.createDocumentFragment();
    for (const row of state.rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "row";
      rowEl.style.height = `${row.height}px`;
      rowEl.style.gap = `${GAP}px`;
      for (const tile of row.tiles) {
        const item = state.section.items[tile.index];
        if (!item)
          continue;
        rowEl.append(this.tile(item, tile.w, tile.h, state, tile.index));
      }
      fragment.append(rowEl);
    }
    state.body.replaceChildren(fragment);
  }
  tile(item, w, h, state, indexInSection) {
    const button = document.createElement("button");
    button.className = item.kind === "video" ? "tile tile-video" : "tile";
    button.type = "button";
    button.style.width = `${w}px`;
    button.style.height = `${h}px`;
    button.setAttribute("aria-label", item.key);
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
      if (retried) {
        button.classList.add("broken");
        return;
      }
      retried = true;
      this.thumbUrls.delete(item.key);
      this.setThumb(img, item);
    });
    this.setThumb(img, item);
    button.append(img);
    button.addEventListener("click", () => {
      this.options.onOpen(state.startIndex + indexInSection);
    });
    return button;
  }
  async setThumb(img, item) {
    let url = this.thumbUrls.get(item.key);
    if (!url) {
      url = thumbUrl(this.options.creds, item.key);
      this.thumbUrls.set(item.key, url);
    }
    img.src = await url;
  }
  measured(state, key, w, h) {
    const before = this.options.meta.get(key);
    this.options.meta.observe(key, w, h);
    if (before && before.w === w && before.h === h)
      return;
    this.dirty.add(state);
    if (this.frame)
      return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const sections = [...this.dirty];
      this.dirty.clear();
      for (const section of sections) {
        this.relayout(section);
        if (section.mounted)
          this.paint(section);
      }
    });
  }
}
function toSections(items, label) {
  const byDate = new Map;
  for (const item of items) {
    let bucket = byDate.get(item.date);
    if (!bucket)
      byDate.set(item.date, bucket = []);
    bucket.push(item);
  }
  return [...byDate.keys()].sort((a, b) => a < b ? 1 : a > b ? -1 : 0).map((date) => ({
    date,
    label: label(date),
    items: byDate.get(date).sort((a, b) => a.key < b.key ? 1 : -1)
  }));
}

// src/lightbox.ts
class Lightbox {
  options;
  items = [];
  index = 0;
  open = false;
  stage;
  caption;
  token = 0;
  constructor(options) {
    this.options = options;
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
    this.stage = root.querySelector(".lb-stage");
    this.caption = root.querySelector(".lb-caption");
    root.querySelector(".lb-close").addEventListener("click", () => this.close());
    root.querySelector(".lb-prev").addEventListener("click", () => this.step(-1));
    root.querySelector(".lb-next").addEventListener("click", () => this.step(1));
    root.addEventListener("click", (event) => {
      if (event.target === root)
        this.close();
    });
    document.addEventListener("keydown", this.onKeyDown);
  }
  setItems(items) {
    this.items = items;
  }
  show(index) {
    if (index < 0 || index >= this.items.length)
      return;
    this.index = index;
    this.open = true;
    this.options.root.hidden = false;
    document.body.classList.add("lb-open");
    this.options.root.focus();
    this.render();
  }
  close() {
    if (!this.open)
      return;
    this.open = false;
    this.token++;
    this.options.root.hidden = true;
    document.body.classList.remove("lb-open");
    this.stage.replaceChildren();
  }
  destroy() {
    document.removeEventListener("keydown", this.onKeyDown);
  }
  step(delta) {
    const next = this.index + delta;
    if (next < 0 || next >= this.items.length)
      return;
    this.index = next;
    this.render();
  }
  onKeyDown = (event) => {
    if (!this.open)
      return;
    if (event.key === "Escape")
      this.close();
    else if (event.key === "ArrowLeft")
      this.step(-1);
    else if (event.key === "ArrowRight")
      this.step(1);
    else
      return;
    event.preventDefault();
  };
  async render() {
    const item = this.items[this.index];
    if (!item)
      return;
    const mine = ++this.token;
    this.caption.textContent = `${item.key} — ${this.index + 1} of ${this.items.length}`;
    this.stage.replaceChildren(spinner());
    const url = await originalUrl(this.options.creds, item.key);
    if (mine !== this.token)
      return;
    const media = item.kind === "video" ? videoElement(url) : imageElement(url, item.key);
    this.stage.replaceChildren(media);
  }
}
function imageElement(url, key) {
  const img = document.createElement("img");
  img.className = "lb-media";
  img.decoding = "async";
  img.alt = key;
  img.src = url;
  return img;
}
function videoElement(url) {
  const video = document.createElement("video");
  video.className = "lb-media";
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  video.src = url;
  return video;
}
function spinner() {
  const el = document.createElement("div");
  el.className = "lb-spinner";
  return el;
}

// src/meta.ts
var FLUSH_MS = 400;

class MeasuredProvider {
  cache = new Map;
  pending = new Map;
  timer;
  static async load() {
    const provider = new MeasuredProvider;
    provider.cache = await getAllMeta();
    return provider;
  }
  get(key) {
    return this.cache.get(key);
  }
  observe(key, w, h) {
    if (!(w > 0 && h > 0))
      return;
    const existing = this.cache.get(key);
    if (existing && existing.w === w && existing.h === h)
      return;
    const record = { ...existing, w, h };
    this.cache.set(key, record);
    this.pending.set(key, record);
    this.scheduleFlush();
  }
  scheduleFlush() {
    if (this.timer !== undefined)
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const batch = this.pending;
      this.pending = new Map;
      putMetaBatch(batch);
    }, FLUSH_MS);
  }
}

// src/rail.ts
var THUMB_H = 44;
var MIN_LABEL_GAP = 22;
function spaceOut(wanted, minGap, height) {
  const ys = [...wanted];
  if (ys.length === 0)
    return ys;
  const margin = minGap / 2;
  const room = Math.max(0, height - margin * 2);
  const gap = ys.length > 1 ? Math.min(minGap, room / (ys.length - 1)) : minGap;
  for (let i = 1;i < ys.length; i++) {
    ys[i] = Math.max(ys[i], ys[i - 1] + gap);
  }
  let ceiling = height - margin;
  for (let i = ys.length - 1;i >= 0; i--) {
    ys[i] = Math.min(ys[i], ceiling);
    ceiling = ys[i] - gap;
  }
  return ys;
}
function probeOffset(fraction, maxScroll, viewportHeight) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return clamped * maxScroll + clamped * viewportHeight;
}

class Rail {
  options;
  labels = new Map;
  thumb;
  bubble;
  active;
  dragging = false;
  measuredAt = -1;
  resize;
  constructor(options) {
    this.options = options;
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
    this.resize = new ResizeObserver(() => this.sync());
    this.resize.observe(options.content);
    this.thumb.addEventListener("pointerdown", this.onPointerDown);
    root.addEventListener("pointermove", this.onPointerMove);
    root.addEventListener("pointerup", this.onPointerUp);
    root.addEventListener("pointercancel", this.onPointerUp);
  }
  setYears(years) {
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
  sync() {
    const { scroller } = this.options;
    const max = this.maxScroll();
    if (scroller.scrollHeight !== this.measuredAt) {
      this.placeLabels(max);
      this.measuredAt = scroller.scrollHeight;
    }
    const fraction = max > 0 ? scroller.scrollTop / max : 0;
    this.thumb.style.top = `${this.railY(fraction) - THUMB_H / 2}px`;
    if (!this.dragging)
      this.setActive(this.dateAt(fraction));
  }
  destroy() {
    this.resize.disconnect();
    this.options.root.replaceChildren();
  }
  maxScroll() {
    const { scroller } = this.options;
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }
  railY(fraction) {
    const height = this.options.root.clientHeight;
    const usable = Math.max(0, height - THUMB_H);
    return THUMB_H / 2 + Math.min(1, Math.max(0, fraction)) * usable;
  }
  placeLabels(max) {
    const anchors = this.options.timeline.yearAnchors();
    const wanted = anchors.map(({ top }) => this.railY(max > 0 ? top / max : 0));
    const ys = spaceOut(wanted, MIN_LABEL_GAP, this.options.root.clientHeight);
    anchors.forEach(({ year }, i) => {
      const el = this.labels.get(year);
      if (el)
        el.style.top = `${ys[i]}px`;
    });
  }
  dateAt(fraction) {
    const probe = probeOffset(fraction, this.maxScroll(), this.options.scroller.clientHeight);
    return this.options.timeline.dateAtOffset(probe);
  }
  setActive(date) {
    const year = date ? yearOf(date) : undefined;
    if (year !== this.active) {
      this.active = year;
      for (const [name, el] of this.labels)
        el.classList.toggle("active", name === year);
    }
    if (date)
      this.bubble.textContent = monthLabel(date);
  }
  scrollToYear(year) {
    const anchor = this.options.timeline.yearAnchors().find((a) => a.year === year);
    if (anchor)
      this.options.scroller.scrollTo({ top: anchor.top });
  }
  onPointerDown = (event) => {
    this.dragging = true;
    this.options.root.setPointerCapture(event.pointerId);
    this.bubble.hidden = false;
    this.thumb.classList.add("dragging");
    event.preventDefault();
  };
  onPointerMove = (event) => {
    if (!this.dragging)
      return;
    const box = this.options.root.getBoundingClientRect();
    const usable = Math.max(1, box.height - THUMB_H);
    const fraction = (event.clientY - box.top - THUMB_H / 2) / usable;
    const clamped = Math.min(1, Math.max(0, fraction));
    this.options.scroller.scrollTop = clamped * this.maxScroll();
    this.thumb.style.top = `${this.railY(clamped) - THUMB_H / 2}px`;
    this.bubble.style.top = `${this.railY(clamped)}px`;
    this.setActive(this.dateAt(clamped));
  };
  onPointerUp = (event) => {
    if (!this.dragging)
      return;
    this.dragging = false;
    this.bubble.hidden = true;
    this.thumb.classList.remove("dragging");
    if (this.options.root.hasPointerCapture(event.pointerId)) {
      this.options.root.releasePointerCapture(event.pointerId);
    }
  };
}

// src/search/suggest.ts
var EMBEDDING_MODEL = "gemini-embedding-001";
var THRESHOLD = 0.5;
var LIMIT = 5;
function cosine(a, bFrom, b, dims) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0;i < dims; i++) {
    const x = a[i] ?? 0;
    const y = b[bFrom + i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0)
    return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function scoreLabels(embeddings, queryVec) {
  if (embeddings.model !== EMBEDDING_MODEL)
    return [];
  if (queryVec.length !== embeddings.dims)
    return [];
  const scored = [];
  for (let i = 0;i < embeddings.labels.length; i++) {
    scored.push({
      label: embeddings.labels[i],
      score: cosine(queryVec, i * embeddings.dims, embeddings.vectors, embeddings.dims)
    });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored;
}
function pickPass(untranslated, translated) {
  const bestOf = (pass) => pass[0]?.score ?? -1;
  const winner = bestOf(translated) > bestOf(untranslated) ? translated : untranslated;
  return winner.filter((s) => s.score >= THRESHOLD).slice(0, LIMIT).map((s) => s.label);
}
function mergeSuggestions(places, labels) {
  const seen = new Set;
  const out = [];
  for (const suggestion of [...places, ...labels.map((l) => ({ display: l, query: l }))]) {
    const queryLower = suggestion.query.toLowerCase();
    if (seen.has(queryLower))
      continue;
    seen.add(queryLower);
    out.push(suggestion);
  }
  return out;
}

// src/search/google.ts
var TRANSLATE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
var EMBED_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
var CACHE_TTL_MS = 600000;
var DIMENSIONS = 768;
var SOURCE_LANGUAGE = "da";
var translations = new Map;
var embeddings = new Map;
function clearGoogleCaches() {
  translations.clear();
  embeddings.clear();
}
function cached(store, key, now) {
  const entry = store.get(key);
  if (entry === undefined)
    return;
  if (now - entry.at >= CACHE_TTL_MS) {
    store.delete(key);
    return;
  }
  return entry.value;
}
async function translateQuery(query, apiKey, fetchImpl = fetch, now = Date.now) {
  const cacheKey = query.toLowerCase();
  const hit = cached(translations, cacheKey, now());
  if (hit !== undefined)
    return hit;
  try {
    const response = await fetchImpl(`${TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ q: query, source: SOURCE_LANGUAGE, target: "en" }).toString()
    });
    if (!response.ok)
      return null;
    const body = await response.json();
    const text2 = body.data?.translations?.[0]?.translatedText;
    if (typeof text2 !== "string")
      return null;
    const translated = text2.trim().toLowerCase();
    translations.set(cacheKey, { value: translated, at: now() });
    return translated;
  } catch {
    return null;
  }
}
async function embedQuery(query, apiKey, fetchImpl = fetch, now = Date.now) {
  const cacheKey = query.toLowerCase();
  const hit = cached(embeddings, cacheKey, now());
  if (hit !== undefined)
    return hit;
  try {
    const url = `${EMBED_ENDPOINT}/${EMBEDDING_MODEL}:embedContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text: query }] },
        outputDimensionality: DIMENSIONS
      })
    });
    if (!response.ok)
      return null;
    const body = await response.json();
    const values = body.embedding?.values;
    if (!Array.isArray(values) || values.length === 0)
      return null;
    if (!values.every((v) => typeof v === "number" && Number.isFinite(v)))
      return null;
    const vector = values;
    embeddings.set(cacheKey, { value: vector, at: now() });
    return vector;
  } catch {
    return null;
  }
}

// src/search/nominatim.ts
var ENDPOINT = "https://nominatim.openstreetmap.org/search";
function str(value) {
  return typeof value === "string" ? value : null;
}
function parsePlace(raw) {
  if (typeof raw !== "object" || raw === null)
    return null;
  const row = raw;
  const lat = Number(row["lat"]);
  const lon = Number(row["lon"]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    return null;
  const names = row["namedetails"] ?? {};
  const address = row["address"] ?? {};
  let boundingBox = null;
  const box = row["boundingbox"];
  if (Array.isArray(box) && box.length === 4) {
    const nums = box.map((v) => Number(v));
    if (nums.every((n) => Number.isFinite(n))) {
      boundingBox = [nums[0], nums[1], nums[2], nums[3]];
    }
  }
  const geo = row["geojson"];
  const geojson = typeof geo === "object" && geo !== null && typeof geo.type === "string" ? geo : null;
  return {
    displayName: str(row["display_name"]) ?? "",
    name: str(row["name"]),
    nameEn: str(names["name:en"]),
    nameDa: str(names["name:da"]),
    country: str(address["country"]),
    lat,
    lon,
    boundingBox,
    geojson
  };
}
function matchesExactName(place, query) {
  const wanted = query.trim().toLowerCase();
  if (wanted === "")
    return false;
  for (const candidate of [place.name, place.nameEn, place.nameDa]) {
    if (candidate !== null && candidate.trim().toLowerCase() === wanted)
      return true;
  }
  return false;
}
function containsPoint(place, lat, lon) {
  const geo = place.geojson;
  if (geo === null)
    return null;
  if (geo.type === "Polygon") {
    return Array.isArray(geo.coordinates) ? inRings(lat, lon, geo.coordinates) : null;
  }
  if (geo.type === "MultiPolygon") {
    if (!Array.isArray(geo.coordinates))
      return null;
    for (const polygon of geo.coordinates) {
      if (Array.isArray(polygon) && inRings(lat, lon, polygon))
        return true;
    }
    return false;
  }
  return null;
}
function inRings(lat, lon, rings) {
  const outer = rings[0];
  if (!Array.isArray(outer))
    return false;
  if (!inRing(lat, lon, outer))
    return false;
  for (let i = 1;i < rings.length; i++) {
    const hole = rings[i];
    if (Array.isArray(hole) && inRing(lat, lon, hole))
      return false;
  }
  return true;
}
function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1;i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!Array.isArray(a) || !Array.isArray(b))
      continue;
    const xi = Number(a[0]);
    const yi = Number(a[1]);
    const xj = Number(b[0]);
    const yj = Number(b[1]);
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) {
      continue;
    }
    const crosses = yi > lat !== yj > lat;
    if (crosses && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
async function searchNominatim(query, options = {}) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    limit: "5",
    polygon_geojson: "1",
    namedetails: "1",
    polygon_threshold: "0.01"
  });
  if (options.addressDetails === true)
    params.set("addressdetails", "1");
  if (options.acceptLanguage !== undefined)
    params.set("accept-language", options.acceptLanguage);
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${ENDPOINT}?${params.toString()}`);
    if (!response.ok)
      return [];
    const body = await response.json();
    if (!Array.isArray(body))
      return [];
    const places = [];
    for (const row of body) {
      const parsed = parsePlace(row);
      if (parsed !== null)
        places.push(parsed);
    }
    return places;
  } catch {
    return [];
  }
}

// src/search/tokenize.ts
function normalize(text2) {
  return text2.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// src/search/local.ts
function matchLabels(index, term) {
  const out = new Set;
  const trimmed = term.trim().toLowerCase();
  if (trimmed === "")
    return out;
  const needle = ` ${trimmed} `;
  for (let t = 0;t < index.labelTerms.length; t++) {
    if (!` ${index.labelTerms[t]} `.includes(needle))
      continue;
    const start = index.labelOffsets[t];
    const end = index.labelOffsets[t + 1];
    for (let p = start;p < end; p++)
      out.add(index.keys[index.labelPostings[p]]);
  }
  return out;
}
function matchOcr(index, query) {
  const out = new Set;
  const phrase = normalize(query);
  if (phrase === "")
    return out;
  const needle = ` ${phrase} `;
  for (let i = 0;i < index.ocrText.length; i++) {
    if (` ${index.ocrText[i]} `.includes(needle))
      out.add(index.keys[index.ocrKeys[i]]);
  }
  return out;
}
function matchNames(items, query) {
  const out = new Set;
  const needle = query.trim().toLowerCase();
  if (needle === "")
    return out;
  for (const item of items) {
    const name = item.key.slice(item.key.lastIndexOf("/") + 1);
    if (name.toLowerCase().includes(needle))
      out.add(item.key);
  }
  return out;
}
function pointsInBox(index, south, north, west, east) {
  const out = [];
  for (let i = 0;i < index.geoKeys.length; i++) {
    const lat = index.geoLat[i];
    const lon = index.geoLon[i];
    if (lat < south || lat > north || lon < west || lon > east)
      continue;
    out.push({ key: index.keys[index.geoKeys[i]], lat, lon });
  }
  return out;
}

// src/search/search.ts
var MIN_PLACE_QUERY = 3;
var DEFAULT_TIMEOUT_MS = 3000;
var PLACE_SUGGESTION_LIMIT = 5;
function within(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}
async function runSearch(query, deps) {
  const trimmed = query.trim();
  if (trimmed === "")
    return new Set;
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const placePass = within(placeMatches(trimmed, deps), timeout, new Set);
  const translation = within(deps.translate(trimmed), timeout, null);
  const found = new Set;
  for (const key of matchLabels(deps.index, trimmed))
    found.add(key);
  for (const key of matchOcr(deps.index, trimmed))
    found.add(key);
  for (const key of matchNames(deps.items, trimmed))
    found.add(key);
  const translated = await translation;
  if (translated !== null && translated !== "" && translated !== trimmed.toLowerCase()) {
    for (const key of matchLabels(deps.index, translated))
      found.add(key);
  }
  for (const key of await placePass)
    found.add(key);
  const renderable = new Set(deps.items.map((item) => item.key));
  const out = new Set;
  for (const key of found)
    if (renderable.has(key))
      out.add(key);
  return out;
}
async function placeMatches(query, deps) {
  const out = new Set;
  if (query.length < MIN_PLACE_QUERY)
    return out;
  const candidates = await deps.places(query);
  const place = candidates.find((candidate) => matchesExactName(candidate, query));
  if (place === undefined || place.boundingBox === null)
    return out;
  const [south, north, west, east] = place.boundingBox;
  for (const point of pointsInBox(deps.index, south, north, west, east)) {
    if (containsPoint(place, point.lat, point.lon) === false)
      continue;
    out.add(point.key);
  }
  return out;
}
async function suggestFor(query, deps) {
  const trimmed = query.trim();
  if (trimmed.length < MIN_PLACE_QUERY)
    return [];
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const places = within(placeSuggestions(trimmed, deps), timeout, []);
  const labels = within(labelSuggestions(trimmed, deps), timeout, []);
  return mergeSuggestions(await places, await labels);
}
async function placeSuggestions(query, deps) {
  const candidates = await deps.places(query, { addressDetails: true, acceptLanguage: "en" });
  const typed = query.toLowerCase();
  const seen = new Set;
  const out = [];
  for (const place of candidates) {
    const name = place.nameEn ?? place.name;
    if (name === null)
      continue;
    const lowered = name.toLowerCase();
    if (lowered === typed)
      continue;
    if (seen.has(lowered))
      continue;
    seen.add(lowered);
    out.push({
      display: place.country !== null ? `${name} (${place.country})` : name,
      query: name
    });
    if (out.length >= PLACE_SUGGESTION_LIMIT)
      break;
  }
  return out;
}
async function labelSuggestions(query, deps) {
  const embeddings2 = await deps.embeddings();
  if (embeddings2 === null || embeddings2.labels.length === 0)
    return [];
  const rawVec = await deps.embed(query);
  const untranslated = rawVec === null ? [] : scoreLabels(embeddings2, rawVec);
  let translatedScores = [];
  const translated = await deps.translate(query);
  if (translated !== null && translated !== "" && translated !== query.toLowerCase()) {
    const vec = await deps.embed(translated);
    if (vec !== null)
      translatedScores = scoreLabels(embeddings2, vec);
  }
  return pickPass(untranslated, translatedScores);
}

// src/search/store.ts
var INDEX = "index";
var EMBEDDINGS = "embeddings";
var SNAPSHOT = "snapshot";
var API_KEY = "apikey";
async function getSnapshot() {
  const value = await getSearch(SNAPSHOT);
  return typeof value === "number" ? value : null;
}
function saveImport(result, lastModified) {
  return putSearchAll([
    [INDEX, result.index],
    [EMBEDDINGS, result.embeddings],
    [API_KEY, result.apiKey],
    [SNAPSHOT, lastModified]
  ]);
}
async function loadIndex() {
  return await getSearch(INDEX) ?? null;
}
async function loadEmbeddings() {
  return await getSearch(EMBEDDINGS) ?? null;
}
async function loadApiKey() {
  const raw = await getSearch(API_KEY);
  if (typeof raw !== "string" || raw === "")
    return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.apiKey === "string" && parsed.apiKey !== "" ? parsed.apiKey : null;
  } catch {
    return null;
  }
}

// src/main.ts
var el = (id) => document.getElementById(id);
var screens = {
  setup: () => el("setup"),
  gallery: () => el("gallery"),
  failure: () => el("failure")
};
function show(name) {
  for (const [key, get] of Object.entries(screens)) {
    get().hidden = key !== name;
  }
}
function status(message, busy = false) {
  const bar = el("status");
  bar.textContent = message;
  bar.classList.toggle("busy", busy);
  bar.hidden = message === "";
}
start();
async function start() {
  if (!globalThis.crypto?.subtle) {
    fail("This page needs Web Crypto", "crypto.subtle is only available in a secure context. Serve the page over http://localhost or https rather than opening the file directly.");
    return;
  }
  let creds;
  try {
    creds = await getCreds();
  } catch (error) {
    fail("Could not open local storage", explain(error));
    return;
  }
  if (creds)
    boot(creds);
  else
    showSetup();
}
function showSetup(prefill, message) {
  show("setup");
  const form = el("setup-form");
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
    const creds = {
      endpoint: String(data.get("endpoint") ?? "").trim(),
      region: String(data.get("region") ?? "").trim(),
      bucket: String(data.get("bucket") ?? "").trim(),
      accessKey: String(data.get("accessKey") ?? "").trim(),
      secretKey: String(data.get("secretKey") ?? "").trim(),
      sessionToken: String(data.get("sessionToken") ?? "").trim() || undefined,
      googleApiKey: String(data.get("googleApiKey") ?? "").trim() || undefined
    };
    const button = el("setup-submit");
    button.disabled = true;
    note.hidden = true;
    try {
      await verify(creds);
      await putCreds(creds);
      boot(creds);
    } catch (error) {
      button.disabled = false;
      note.textContent = explain(error);
      note.hidden = false;
    }
  };
}
async function boot(creds) {
  show("gallery");
  status("Loading…", true);
  const meta = await MeasuredProvider.load();
  const scroller = el("scroller");
  const lightbox = new Lightbox({ root: el("lightbox"), creds });
  const grid = new Grid({
    container: el("grid"),
    scroller,
    creds,
    meta,
    onOpen: (index) => lightbox.show(index)
  });
  const rail = new Rail({
    root: el("rail"),
    scroller,
    content: el("grid"),
    timeline: grid
  });
  let library = [];
  const render = (items) => {
    const sections = toSections(items, dateLabel);
    grid.setSections(sections);
    rail.setYears([...new Set(sections.map((s) => s.date.slice(0, 4)))]);
    lightbox.setItems(grid.items);
  };
  const renderLibrary = (items) => {
    library = items;
    render(items);
    status(items.length === 0 ? "No photos found. Expected keys shaped like 2022/08/29/IMG_1234.jpg" : "");
  };
  let ticking = false;
  scroller.addEventListener("scroll", () => {
    if (ticking)
      return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      rail.sync();
    });
  }, { passive: true });
  el("forget").onclick = async () => {
    if (!confirm("Forget credentials and delete the local cache?"))
      return;
    clearGoogleCaches();
    await clearCreds();
    await nuke();
    location.reload();
  };
  const cached2 = await getManifest();
  const hadCache = cached2.length > 0;
  if (hadCache)
    renderLibrary(cached2);
  try {
    const fresh = await listAll(creds, ({ pages, items }) => {
      if (!hadCache)
        status(`Listing bucket… ${items} items across ${pages} pages`, true);
    });
    if (changed(cached2, fresh)) {
      await putManifest(fresh);
      renderLibrary(fresh);
    } else if (!hadCache) {
      renderLibrary(fresh);
    }
  } catch (error) {
    if (hadCache)
      status(`Showing cached library — refresh failed: ${explain(error)}`);
    else
      failFrom(error, creds);
  }
  wireSearch(creds, () => library, render);
  const [remote, local] = await Promise.all([remoteSnapshot(creds), getSnapshot()]);
  if (remote !== null && remote !== local) {
    status("Importing search index…", true);
    const url = await presignGet({ creds, key: SNAPSHOT_KEY });
    const result = await importSnapshot(url, (loaded, total) => {
      const mb = (bytes) => (bytes / 1e6).toFixed(1);
      status(total > 0 ? `Importing search index… ${mb(loaded)}/${mb(total)} MB` : `Importing search index… ${mb(loaded)} MB`, true);
    });
    if (result === null) {
      status(local === null ? "Search index could not be built — search is unavailable this session." : "Search index could not be updated — searching the previous snapshot.");
    } else {
      await saveImport(result, remote);
      status("");
      location.reload();
    }
  }
}
var STATUS_KEY = ".meta/db-status.json";
var SNAPSHOT_KEY = ".meta/s3immich.db.gz";
async function remoteSnapshot(creds) {
  try {
    const response = await fetch(await presignGet({ creds, key: STATUS_KEY }));
    if (!response.ok)
      return null;
    const body = await response.json();
    return typeof body.lastModified === "number" ? body.lastModified : null;
  } catch {
    return null;
  }
}
function importSnapshot(url, onProgress) {
  return new Promise((resolve) => {
    const worker = new Worker("dist/search-worker.js");
    const finish = (result) => {
      worker.terminate();
      resolve(result);
    };
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "progress")
        onProgress(message.loaded, message.total);
      else if (message.type === "done")
        finish(message.result);
      else
        finish(null);
    };
    worker.onerror = () => finish(null);
    worker.postMessage({ url });
  });
}
function wireSearch(creds, getItems, render) {
  const form = el("search-form");
  const input = el("search-input");
  const clear = el("search-clear");
  const summary = el("search-summary");
  const chips = el("search-chips");
  let index = null;
  loadIndex().then((loaded) => {
    index = loaded;
    form.hidden = loaded === null;
  });
  form.hidden = true;
  const showChips = (suggestions) => {
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
  let generation = 0;
  const reset = () => {
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
      const apiKey = creds.googleApiKey ?? await loadApiKey();
      const deps = {
        index,
        items: getItems(),
        translate: (q) => apiKey === null ? Promise.resolve(null) : translateQuery(q, apiKey),
        embed: (q) => apiKey === null ? Promise.resolve(null) : embedQuery(q, apiKey),
        places: (q, options) => searchNominatim(q, options),
        embeddings: loadEmbeddings
      };
      const keys = await runSearch(query, deps);
      if (mine !== generation)
        return;
      const matches = getItems().filter((item) => keys.has(item.key));
      render(matches);
      if (matches.length > 0) {
        summary.textContent = `${matches.length} ${matches.length === 1 ? "match" : "matches"} for “${query}”`;
        showChips([]);
        return;
      }
      summary.textContent = `No matches for “${query}”`;
      const suggestions = await suggestFor(query, deps);
      if (mine !== generation)
        return;
      showChips(suggestions);
    } catch (error) {
      if (mine !== generation)
        return;
      summary.textContent = `Search failed: ${explain(error)}`;
      showChips([]);
    }
  };
}
function changed(a, b) {
  if (a.length !== b.length)
    return true;
  const left = a.map((i) => i.key).sort();
  const right = b.map((i) => i.key).sort();
  return left.some((key, i) => key !== right[i]);
}
function failFrom(error, creds) {
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
function fail(title, detail, asHtml = false) {
  show("failure");
  el("failure-title").textContent = title;
  const body = el("failure-detail");
  if (asHtml)
    body.innerHTML = detail;
  else
    body.textContent = detail;
}
function corsHelp() {
  const origin = location.origin;
  const rule = JSON.stringify([{ AllowedOrigins: [origin], AllowedMethods: ["GET", "HEAD"], AllowedHeaders: ["*"], MaxAgeSeconds: 3000 }], null, 2);
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
function explain(error) {
  if (error instanceof S3Error)
    return `${error.code}: ${error.message}`;
  if (error instanceof NetworkError) {
    return "Could not reach the bucket. Check the endpoint, and that the bucket allows this origin via CORS.";
  }
  return error instanceof Error ? error.message : String(error);
}
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}
