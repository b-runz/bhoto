/**
 * AWS Signature Version 4, query-string ("presigned URL") flavour.
 * Hand-rolled against the AWS docs; the only dependency is Web Crypto.
 *
 * subtle needs a secure context, so serve over http://localhost or https --
 * a file:// origin has no crypto.subtle at all.
 */
import type { Creds } from "./types";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const UNSIGNED = "UNSIGNED-PAYLOAD";

const encoder = new TextEncoder();

export interface PresignOptions {
  creds: Creds;
  /** Object key, unencoded. */
  key: string;
  /** Lifetime in seconds. */
  expires?: number;
  /** Extra signed query params, e.g. response-content-type. */
  query?: Record<string, string>;
  /** Injectable clock; tests pin it. */
  now?: Date;
}

/**
 * The derived key depends only on (secret, date, region), so signing 20k
 * URLs costs one four-step chain plus one HMAC each, not four each.
 */
const signingKeys = new Map<string, Promise<Uint8Array>>();

export async function presignGet(options: PresignOptions): Promise<string> {
  const { creds, key } = options;
  const expires = options.expires ?? 3600;
  const now = options.now ?? new Date();

  const region = creds.region.trim();
  const host = `${creds.bucket.trim()}.${normaliseEndpoint(creds.endpoint)}`;
  const canonicalUri = "/" + encodePath(key.trim().replace(/^\/+/, ""));

  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;

  const params: Record<string, string> = {
    ...options.query,
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${creds.accessKey.trim()}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };

  // For presigned URLs the session token is signed as a query parameter,
  // not carried as a header the way it is for normal SigV4 requests.
  const token = creds.sessionToken?.trim();
  if (token) params["X-Amz-Security-Token"] = token;

  const query = canonicalQuery(params);

  const canonicalRequest = [
    "GET",
    canonicalUri,
    query,
    `host:${host}\n`,
    "host",
    UNSIGNED,
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    hex(await sha256(canonicalRequest)),
  ].join("\n");

  const signature = hex(
    await hmac(await signingKey(creds.secretKey, dateStamp, region), stringToSign),
  );

  return `https://${host}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}

/** Accepts "https://s3.fr-par.scw.cloud", "s3.fr-par.scw.cloud/", etc. */
export function normaliseEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function signingKey(secret: string, dateStamp: string, region: string): Promise<Uint8Array> {
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

/** Test seam: the cache is keyed on the secret, so it survives cred changes. */
export function clearSigningKeyCache(): void {
  signingKeys.clear();
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(params[name]!)}`)
    .join("&");
}

/**
 * RFC 3986. encodeURIComponent leaves ! ' ( ) * alone and AWS wants those
 * percent-encoded too, so patch them up afterwards.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Object keys are paths: encode each segment, keep the separators. */
function encodePath(key: string): string {
  return key.split("/").map(uriEncode).join("/");
}

function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(input));
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return new Uint8Array(sig);
}

function hex(buffer: ArrayBuffer | Uint8Array): string {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}
