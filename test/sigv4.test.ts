import { describe, expect, test } from "bun:test";
import fixtures from "./fixtures/sigv4.json";
import { clearSigningKeyCache, normaliseEndpoint, presignGet } from "../src/sigv4";
import type { Creds } from "../src/types";

/**
 * Fixtures come from tools/gen_sigv4_fixtures.py, an independent
 * implementation of the AWS spec sharing no code with src/sigv4.ts.
 * Agreement between the two is the test.
 */
describe("presignGet against an independent implementation", () => {
  for (const f of fixtures) {
    test(f.name, async () => {
      const url = await presignGet({
        creds: f.creds as Creds,
        key: f.key,
        expires: f.expires,
        query: f.query as Record<string, string>,
        now: pinned(f.amzDate),
      });
      expect(url).toBe(f.url);
    });
  }
});

describe("presignGet details", () => {
  const creds: Creds = {
    endpoint: "https://s3.fr-par.scw.cloud",
    region: "fr-par",
    bucket: "my-bucket",
    accessKey: "SCWXXXXXXXXXXXXXXXXX",
    secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  };

  test("sorts an override into position rather than appending it", async () => {
    const url = await presignGet({
      creds,
      key: ".thumbs/2022/08/29/VID_0001.mp4",
      query: { "response-content-type": "image/jpeg" },
      now: pinned("20260831T123456Z"),
    });
    // Sorted by name: X-Amz-* sort before lowercase "response-...".
    const order = [...url.matchAll(/[?&]([A-Za-z-]+)=/g)].map((m) => m[1]);
    const params = order.filter((p) => p !== "X-Amz-Signature");
    expect(params).toEqual([...params].sort());
    expect(url).toContain("response-content-type=image%2Fjpeg");
    expect(url.endsWith("&X-Amz-Signature=" + url.split("X-Amz-Signature=")[1])).toBe(true);
  });

  test("percent-encodes the path but keeps separators", async () => {
    const url = await presignGet({ creds, key: "2022/08/29/a b.jpg", now: pinned("20260831T123456Z") });
    expect(url).toContain("/2022/08/29/a%20b.jpg?");
  });

  test("a cached signing key does not leak between secrets", async () => {
    clearSigningKeyCache();
    const at = pinned("20260831T123456Z");
    const first = await presignGet({ creds, key: "a/b/c/x.jpg", now: at });
    const second = await presignGet({
      creds: { ...creds, secretKey: "aDifferentSecretaDifferentSecret00000000" },
      key: "a/b/c/x.jpg",
      now: at,
    });
    expect(first).not.toBe(second);
  });

  test("the cache still returns a stable signature for identical input", async () => {
    const at = pinned("20260831T123456Z");
    const a = await presignGet({ creds, key: "a/b/c/x.jpg", now: at });
    const b = await presignGet({ creds, key: "a/b/c/x.jpg", now: at });
    expect(a).toBe(b);
  });
});

describe("normaliseEndpoint", () => {
  test("strips scheme, trailing slashes and surrounding space", () => {
    for (const input of [
      "https://s3.fr-par.scw.cloud",
      "http://s3.fr-par.scw.cloud/",
      "  s3.fr-par.scw.cloud//  ",
      "HTTPS://s3.fr-par.scw.cloud",
    ]) {
      expect(normaliseEndpoint(input)).toBe("s3.fr-par.scw.cloud");
    }
  });
});

/** "20260831T123456Z" -> Date. */
function pinned(amzDate: string): Date {
  const iso = amzDate.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    "$1-$2-$3T$4:$5:$6.000Z",
  );
  return new Date(iso);
}
