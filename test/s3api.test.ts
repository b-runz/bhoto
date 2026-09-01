import { describe, expect, test } from "bun:test";
import { deleteItems, deleteObject, NetworkError, S3Error } from "../src/s3api";
import type { Creds } from "../src/types";

const creds: Creds = {
  endpoint: "https://s3.fr-par.scw.cloud",
  region: "fr-par",
  bucket: "my-bucket",
  accessKey: "SCWXXXXXXXXXXXXXXXXX",
  secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

/** Records every request, answering 204 unless a key is listed in `fail`. */
function recorder(fail: Record<string, { status: number; code: string }> = {}) {
  const seen: Array<{ method: string; path: string }> = [];
  const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname).slice(1);
    seen.push({ method: init?.method ?? "GET", path });
    const bad = fail[path];
    if (bad) {
      return new Response(
        `<?xml version="1.0"?><Error><Code>${bad.code}</Code><Message>nope</Message></Error>`,
        { status: bad.status },
      );
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

describe("deleteObject", () => {
  test("issues a DELETE against the signed key", async () => {
    const { seen, fetchImpl } = recorder();
    await deleteObject(creds, "2022/08/29/IMG_1234.jpg", fetchImpl);
    expect(seen).toEqual([{ method: "DELETE", path: "2022/08/29/IMG_1234.jpg" }]);
  });

  test("does not put the method in the query string", async () => {
    let href = "";
    const fetchImpl = (async (input: Request | string | URL) => {
      href = String(input);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await deleteObject(creds, "2022/08/29/IMG_1234.jpg", fetchImpl);
    expect(href).toContain("X-Amz-Signature=");
    expect(href).not.toContain("DELETE");
  });

  test("raises the S3 error code from the XML body", async () => {
    const { fetchImpl } = recorder({
      "2022/08/29/IMG_1234.jpg": { status: 403, code: "AccessDenied" },
    });
    const error = await deleteObject(creds, "2022/08/29/IMG_1234.jpg", fetchImpl).catch((e) => e);
    expect(error).toBeInstanceOf(S3Error);
    expect((error as S3Error).code).toBe("AccessDenied");
  });

  test("wraps a thrown fetch as a NetworkError", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const error = await deleteObject(creds, "a.jpg", fetchImpl).catch((e) => e);
    expect(error).toBeInstanceOf(NetworkError);
  });
});

describe("deleteItems", () => {
  test("deletes the original and its thumbnail", async () => {
    const { seen, fetchImpl } = recorder();
    const result = await deleteItems(creds, ["2022/08/29/IMG_1234.jpg"], { fetchImpl });
    expect(result.deleted).toEqual(["2022/08/29/IMG_1234.jpg"]);
    expect(result.failed).toEqual([]);
    expect(seen.map((r) => r.path).sort()).toEqual([
      ".thumbs/2022/08/29/IMG_1234.jpg",
      "2022/08/29/IMG_1234.jpg",
    ]);
  });

  test("a failed thumbnail still counts the photo as deleted", async () => {
    const { fetchImpl } = recorder({
      ".thumbs/2022/08/29/IMG_1234.jpg": { status: 403, code: "AccessDenied" },
    });
    const result = await deleteItems(creds, ["2022/08/29/IMG_1234.jpg"], { fetchImpl });
    expect(result.deleted).toEqual(["2022/08/29/IMG_1234.jpg"]);
    expect(result.failed).toEqual([]);
  });

  test("a failed original is reported and not counted as deleted", async () => {
    const { fetchImpl } = recorder({
      "2022/08/29/B.jpg": { status: 403, code: "AccessDenied" },
    });
    const result = await deleteItems(
      creds,
      ["2022/08/29/A.jpg", "2022/08/29/B.jpg"],
      { fetchImpl },
    );
    expect(result.deleted).toEqual(["2022/08/29/A.jpg"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.key).toBe("2022/08/29/B.jpg");
  });

  test("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const keys = Array.from({ length: 20 }, (_, i) => `2022/08/29/IMG_${i}.jpg`);
    const result = await deleteItems(creds, keys, { fetchImpl, concurrency: 3 });
    expect(result.deleted).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("reports progress once per photo", async () => {
    const { fetchImpl } = recorder();
    const seen: number[] = [];
    const keys = ["2022/08/29/A.jpg", "2022/08/29/B.jpg", "2022/08/29/C.jpg"];
    await deleteItems(creds, keys, { fetchImpl, onProgress: (done) => seen.push(done) });
    expect(seen).toEqual([1, 2, 3]);
  });

  test("deleting nothing touches the network not at all", async () => {
    const { seen, fetchImpl } = recorder();
    const result = await deleteItems(creds, [], { fetchImpl });
    expect(result).toEqual({ deleted: [], failed: [] });
    expect(seen).toEqual([]);
  });
});
