import { beforeEach, describe, expect, test } from "bun:test";
import { clearGoogleCaches, embedQuery, translateQuery } from "../../src/search/google";

beforeEach(() => clearGoogleCaches());

function ok(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

const translation = { data: { translations: [{ translatedText: "Train" }] } };

describe("translateQuery", () => {
  test("posts form-encoded, forcing Danish as the source", async () => {
    let seen: Request | undefined;
    const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
      seen = new Request(input as never, init);
      return new Response(JSON.stringify(translation), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await translateQuery("tog", "KEY", fetchImpl)).toBe("train");

    expect(seen!.method).toBe("POST");
    expect(new URL(seen!.url).searchParams.get("key")).toBe("KEY");
    expect(seen!.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const body = new URLSearchParams(await seen!.text());
    expect(body.get("q")).toBe("tog");
    // Auto-detect is unreliable on short context-free words -- "kat" comes
    // back "at", "bil" comes back "was". Forcing da fixes those.
    expect(body.get("source")).toBe("da");
    expect(body.get("target")).toBe("en");
  });

  test("lowercases and trims the translation", async () => {
    expect(await translateQuery("tog", "KEY", ok(translation))).toBe("train");
  });

  test("memoises on the lowercased query", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify(translation), { status: 200 });
    }) as unknown as typeof fetch;

    await translateQuery("tog", "KEY", counting);
    await translateQuery("TOG", "KEY", counting);
    expect(calls).toBe(1);
  });

  test("re-requests once the cache entry is older than ten minutes", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify(translation), { status: 200 });
    }) as unknown as typeof fetch;

    let clock = 1_000_000;
    await translateQuery("tog", "KEY", counting, () => clock);
    clock += 600_001;
    await translateQuery("tog", "KEY", counting, () => clock);
    expect(calls).toBe(2);
  });

  test("returns null on a non-200, a bad body, or a thrown fetch", async () => {
    const status = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    expect(await translateQuery("tog", "KEY", status)).toBeNull();

    clearGoogleCaches();
    expect(await translateQuery("tog", "KEY", ok({ data: {} }))).toBeNull();

    clearGoogleCaches();
    const boom = (async () => {
      throw new Error("https://translation.googleapis.com/...?key=SECRET failed");
    }) as unknown as typeof fetch;
    expect(await translateQuery("tog", "KEY", boom)).toBeNull();
  });

  test("does not cache a failure", async () => {
    let calls = 0;
    const failing = (async () => {
      calls++;
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    await translateQuery("tog", "KEY", failing);
    await translateQuery("tog", "KEY", failing);
    expect(calls).toBe(2);
  });
});

describe("embedQuery", () => {
  const embedding = { embedding: { values: [0.1, 0.2, 0.3] } };

  test("posts JSON to the pinned model, asking for 768 dimensions", async () => {
    let seen: Request | undefined;
    const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
      seen = new Request(input as never, init);
      return new Response(JSON.stringify(embedding), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await embedQuery("tent", "KEY", fetchImpl)).toEqual([0.1, 0.2, 0.3]);

    expect(seen!.url).toContain("/v1beta/models/gemini-embedding-001:embedContent");
    expect(new URL(seen!.url).searchParams.get("key")).toBe("KEY");
    expect(seen!.headers.get("content-type")).toContain("application/json");
    expect(await seen!.json()).toEqual({
      content: { parts: [{ text: "tent" }] },
      outputDimensionality: 768,
    });
  });

  test("memoises on the lowercased query", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify(embedding), { status: 200 });
    }) as unknown as typeof fetch;

    await embedQuery("Tent", "KEY", counting);
    await embedQuery("tent", "KEY", counting);
    expect(calls).toBe(1);
  });

  test("returns null on a non-200, a bad body, or a thrown fetch", async () => {
    const status = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    expect(await embedQuery("tent", "KEY", status)).toBeNull();

    clearGoogleCaches();
    expect(await embedQuery("tent", "KEY", ok({ embedding: {} }))).toBeNull();

    clearGoogleCaches();
    const boom = (async () => {
      throw new Error("connect failed");
    }) as unknown as typeof fetch;
    expect(await embedQuery("tent", "KEY", boom)).toBeNull();
  });

  test("returns null rather than a partly-numeric vector", async () => {
    expect(await embedQuery("tent", "KEY", ok({ embedding: { values: [1, "x"] } }))).toBeNull();
  });
});

describe("clearGoogleCaches", () => {
  test("forces the next call back to the network", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify(translation), { status: 200 });
    }) as unknown as typeof fetch;

    await translateQuery("tog", "KEY", counting);
    clearGoogleCaches();
    await translateQuery("tog", "KEY", counting);
    expect(calls).toBe(2);
  });
});
