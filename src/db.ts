/**
 * IndexedDB. The only module in the project that persists anything.
 *
 * One database holds credentials, the object manifest, and per-object
 * metadata. Metadata records are open-ended so a later SQLite import can
 * add labels, OCR text, lat/long and EXIF to records that already exist.
 */
import type { Creds, Item, PhotoMeta } from "./types";

const DB_NAME = "s3photos";
const VERSION = 2;
const CREDS_KEY = "current";

let open: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  open ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("creds")) d.createObjectStore("creds");
      if (!d.objectStoreNames.contains("manifest")) d.createObjectStore("manifest", { keyPath: "key" });
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
      if (!d.objectStoreNames.contains("search")) d.createObjectStore("search");
    };
    // A version bump (this project's first, 1 -> 2) can't proceed while
    // another tab holds an older connection open. Without this handler the
    // request never fires success or error -- it just sits blocked -- and
    // every caller awaiting db() hangs forever with no visible failure.
    req.onblocked = () =>
      reject(
        new Error(
          "Another tab has this app open with an older version. Close other tabs of this app and reload.",
        ),
      );
    req.onsuccess = () => {
      const d = req.result;
      // Let this connection get out of the way of a newer tab's upgrade
      // instead of becoming the thing that blocks it.
      d.onversionchange = () => d.close();
      resolve(d);
    };
    req.onerror = () => reject(req.error);
  });
  return open;
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  body: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const req = body(tx.objectStore(store));
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        tx.oncomplete = () => resolve(req ? req.result : undefined);
      }),
  );
}

export async function getCreds(): Promise<Creds | null> {
  const value = await run<Creds>("creds", "readonly", (s) => s.get(CREDS_KEY));
  return value ?? null;
}

export function putCreds(creds: Creds): Promise<unknown> {
  return run("creds", "readwrite", (s) => s.put(creds, CREDS_KEY));
}

export function clearCreds(): Promise<unknown> {
  return run("creds", "readwrite", (s) => s.delete(CREDS_KEY));
}

export async function getManifest(): Promise<Item[]> {
  return (await run<Item[]>("manifest", "readonly", (s) => s.getAll())) ?? [];
}

/** Whole-manifest replace, in one transaction. */
export async function putManifest(items: Item[]): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction("manifest", "readwrite");
    const store = tx.objectStore("manifest");
    store.clear();
    for (const item of items) store.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getAllMeta(): Promise<Map<string, PhotoMeta>> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("meta", "readonly");
    const store = tx.objectStore("meta");
    const keys = store.getAllKeys();
    const values = store.getAll();
    tx.oncomplete = () => {
      const out = new Map<string, PhotoMeta>();
      const k = keys.result as IDBValidKey[];
      const v = values.result as PhotoMeta[];
      for (let i = 0; i < k.length; i++) out.set(String(k[i]), v[i]!);
      resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  });
}

/** Batched so measuring a screenful of thumbnails is one transaction. */
export async function putMetaBatch(entries: Iterable<[string, PhotoMeta]>): Promise<void> {
  const list = [...entries];
  if (list.length === 0) return;
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction("meta", "readwrite");
    const store = tx.objectStore("meta");
    for (const [key, value] of list) store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * The search index, as a handful of large records rather than many small
 * ones. Typed arrays survive structured clone intact, so a posting list is
 * one value here rather than a hundred thousand rows.
 */
export function getSearch<T>(key: string): Promise<T | undefined> {
  return run<T>("search", "readonly", (s) => s.get(key) as IDBRequest<T>);
}

/** One transaction, so an import is all-or-nothing. */
export async function putSearchAll(entries: Array<[string, unknown]>): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction("search", "readwrite");
    const store = tx.objectStore("search");
    for (const [key, value] of entries) store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Wipes everything. Used by "forget credentials". */
export async function nuke(): Promise<void> {
  open = undefined;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
