/**
 * ListObjectsV2, object deletion, and the errors either can hand back.
 * Parsed with DOMParser -- no XML library.
 */
import { parseKey, thumbKey } from "./keys";
import { presignDelete, presignGet } from "./sigv4";
import type { Creds, Item } from "./types";

const PAGE_SIZE = 1000;

/** An error S3 returned in an XML body, as opposed to a transport failure. */
export class S3Error extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "S3Error";
  }
}

/** fetch() failed outright -- CORS rejection and offline look identical here. */
export class NetworkError extends Error {
  constructor(override readonly cause: unknown) {
    super("Could not reach the bucket");
    this.name = "NetworkError";
  }
}

/** Thumbnails are always JPEG whatever the key's extension claims. */
export function thumbUrl(creds: Creds, key: string): Promise<string> {
  return presignGet({
    creds,
    key: thumbKey(key),
    query: { "response-content-type": "image/jpeg" },
  });
}

/** Full-resolution original. Its stored content type is already correct. */
export function originalUrl(creds: Creds, key: string): Promise<string> {
  return presignGet({ creds, key });
}

/**
 * Deletes one object. S3 is idempotent here: a key that is already gone
 * still answers 204, so a photo whose thumbnail was never generated is not
 * an error.
 *
 * Unlike listPage this reads the error body with a regex rather than
 * DOMParser. An S3 error is two flat tags, not a document -- and DOMParser
 * does not exist outside a browser, which is what keeps this path testable.
 */
export async function deleteObject(
  creds: Creds,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = await presignDelete({ creds, key, expires: 300 });

  let response: Response;
  try {
    response = await fetchImpl(url, { method: "DELETE" });
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (response.ok) return;

  const body = await response.text();
  throw new S3Error(
    xmlTag(body, "Code") ?? String(response.status),
    xmlTag(body, "Message") ?? response.statusText,
    response.status,
  );
}

export interface DeleteOptions {
  /** Photos deleted so far, out of `total`. Fires once per photo. */
  onProgress?: (done: number, total: number) => void;
  /** Simultaneous photos in flight. Each one is at least two requests. */
  concurrency?: number;
  /**
   * The other objects that belong to a photo, as the snapshot records them:
   * its thumbnail, a live photo's video, a face sidecar. The conventional
   * `.thumbs/` twin is always attempted as well, so a photo the snapshot
   * does not know still loses its thumbnail.
   */
  companions?: (key: string) => string[];
  fetchImpl?: typeof fetch;
}

export interface DeleteResult {
  /** Keys whose original is gone from the bucket. */
  deleted: string[];
  failed: Array<{ key: string; error: unknown }>;
  /**
   * Companion objects that would not delete for a photo that did. They are
   * still in the bucket. Worth telling the user about: the phone learns of
   * a deletion when the thumbnail it fetches answers 404, so a thumbnail
   * left behind delays that.
   */
  orphans: string[];
}

const DELETE_CONCURRENCY = 6;

/**
 * Deletes originals and their companion objects, a few photos at a time.
 *
 * The order is the phone's own: the original first, and only if that
 * succeeds the rest. The original is what decides the outcome -- it is the
 * object whose absence the phone treats as proof the photo is gone -- and a
 * companion deleted for a photo whose original then failed would leave a
 * blank tile. A companion that will not delete is reported, not fatal:
 * dropping the photo from the library is better than keeping one whose
 * original has already gone.
 */
export async function deleteItems(
  creds: Creds,
  keys: string[],
  options: DeleteOptions = {},
): Promise<DeleteResult> {
  const { onProgress, fetchImpl, companions } = options;
  const limit = Math.max(1, options.concurrency ?? DELETE_CONCURRENCY);

  const result: DeleteResult = { deleted: [], failed: [], orphans: [] };
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      const key = keys[at];
      if (key === undefined) return;

      try {
        await deleteObject(creds, key, fetchImpl);
      } catch (error) {
        result.failed.push({ key, error });
        onProgress?.(++done, keys.length);
        continue;
      }

      // A Set, because the snapshot's thumb_key is normally the conventional
      // twin, and one DELETE per object is enough.
      const extras = new Set(companions?.(key) ?? []);
      extras.add(thumbKey(key));
      for (const extra of extras) {
        try {
          await deleteObject(creds, extra, fetchImpl);
        } catch {
          result.orphans.push(extra);
        }
      }
      result.deleted.push(key);
      onProgress?.(++done, keys.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, keys.length) }, worker));
  return result;
}

export interface ListProgress {
  pages: number;
  items: number;
}

/**
 * Page to the end of the bucket. Keys that are not media in the documented
 * layout -- including everything under .thumbs/ -- are dropped.
 */
export async function listAll(
  creds: Creds,
  onProgress?: (p: ListProgress) => void,
  signal?: AbortSignal,
): Promise<Item[]> {
  const items: Item[] = [];
  let token: string | undefined;
  let pages = 0;

  do {
    const doc = await listPage(creds, token, signal);
    pages++;

    for (const node of doc.querySelectorAll("Contents")) {
      const key = text(node, "Key");
      if (!key) continue;
      const item = parseKey(key, Number(text(node, "Size") ?? 0));
      if (item) items.push(item);
    }

    token = text(doc.documentElement, "NextContinuationToken") ?? undefined;
    onProgress?.({ pages, items: items.length });
  } while (token);

  return items;
}

/** One page. Also used standalone, with maxKeys 1, to validate credentials. */
export async function listPage(
  creds: Creds,
  token?: string,
  signal?: AbortSignal,
  maxKeys = PAGE_SIZE,
): Promise<Document> {
  const query: Record<string, string> = {
    "list-type": "2",
    "max-keys": String(maxKeys),
  };
  if (token) query["continuation-token"] = token;

  // The bucket root is the "key"; the listing parameters are signed query.
  const url = await presignGet({ creds, key: "", query, expires: 300 });

  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new NetworkError(cause);
  }

  const body = await response.text();
  const doc = new DOMParser().parseFromString(body, "text/xml");

  if (!response.ok) {
    throw new S3Error(
      text(doc.documentElement, "Code") ?? String(response.status),
      text(doc.documentElement, "Message") ?? response.statusText,
      response.status,
    );
  }
  if (doc.querySelector("parsererror")) {
    throw new S3Error("MalformedResponse", "The bucket returned unreadable XML", response.status);
  }
  return doc;
}

/** Validate credentials with the cheapest possible real request. */
export async function verify(creds: Creds): Promise<void> {
  await listPage(creds, undefined, undefined, 1);
}

/** First occurrence of a flat XML tag's text, or null. */
function xmlTag(xml: string, name: string): string | null {
  const found = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  const value = found?.[1];
  return value === undefined || value === "" ? null : value;
}

function text(scope: Element | null, tag: string): string | null {
  if (!scope) return null;
  for (const child of scope.children) {
    if (child.tagName === tag) return child.textContent;
  }
  return scope.querySelector(tag)?.textContent ?? null;
}
