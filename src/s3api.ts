/**
 * ListObjectsV2 and the errors it can hand back. Parsed with DOMParser --
 * no XML library.
 */
import { parseKey, thumbKey } from "./keys";
import { presignGet } from "./sigv4";
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

function text(scope: Element | null, tag: string): string | null {
  if (!scope) return null;
  for (const child of scope.children) {
    if (child.tagName === tag) return child.textContent;
  }
  return scope.querySelector(tag)?.textContent ?? null;
}
