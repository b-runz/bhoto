import { describe, expect, test } from "bun:test";
import { maybeGunzip } from "../../src/search/gunzip";

const SQLITE_HEADER = "SQLite format 3 ";

function gzip(bytes: Uint8Array<ArrayBuffer>): Uint8Array {
  return Bun.gzipSync(bytes);
}

describe("maybeGunzip", () => {
  test("decompresses a gzip member", async () => {
    const plain = new TextEncoder().encode(SQLITE_HEADER + "payload");
    const out = await maybeGunzip(gzip(plain));
    expect(new TextDecoder().decode(out)).toBe(SQLITE_HEADER + "payload");
  });

  test("passes an already-decompressed SQLite file straight through", async () => {
    // Some hosts store the object with Content-Encoding: gzip, in which case
    // the browser has already decompressed it by the time we look.
    const plain = new TextEncoder().encode(SQLITE_HEADER + "payload");
    const out = await maybeGunzip(plain);
    expect(out).toEqual(plain);
  });

  test("recognises gzip by its magic bytes, not by content type", async () => {
    const plain = new Uint8Array([1, 2, 3, 4]);
    const compressed = gzip(plain);
    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);
    expect(await maybeGunzip(compressed)).toEqual(plain);
  });

  test("rejects truncated gzip rather than returning half a database", async () => {
    const truncated = gzip(new TextEncoder().encode("x".repeat(4096))).slice(0, 20);
    await expect(maybeGunzip(truncated)).rejects.toThrow();
  });

  test("passes an empty buffer through untouched", async () => {
    expect(await maybeGunzip(new Uint8Array())).toEqual(new Uint8Array());
  });
});
