import { describe, expect, test } from "bun:test";
import {
  containsPoint,
  matchesExactName,
  parsePlace,
  searchNominatim,
} from "../../src/search/nominatim";
import type { NominatimPlace } from "../../src/search/nominatim";

/** A unit square from (0,0) to (10,10), in GeoJSON [lon, lat] order. */
const square = {
  type: "Polygon",
  coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
};

/** The same square with a hole from (4,4) to (6,6). */
const squareWithHole = {
  type: "Polygon",
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
  ],
};

function place(over: Partial<NominatimPlace> = {}): NominatimPlace {
  return {
    displayName: "Somewhere",
    name: "Somewhere",
    nameEn: null,
    nameDa: null,
    country: null,
    lat: 5,
    lon: 5,
    boundingBox: [0, 10, 0, 10],
    geojson: null,
    ...over,
  };
}

describe("parsePlace", () => {
  test("reads the fields the search path needs", () => {
    const parsed = parsePlace({
      display_name: "Catalunya, España",
      name: "Catalunya",
      namedetails: { "name:en": "Catalonia", "name:da": "Catalonien" },
      address: { country: "Spain" },
      lat: "41.8",
      lon: "1.5",
      boundingbox: ["40.5", "42.9", "0.1", "3.3"],
      geojson: square,
    });
    expect(parsed).toEqual({
      displayName: "Catalunya, España",
      name: "Catalunya",
      nameEn: "Catalonia",
      nameDa: "Catalonien",
      country: "Spain",
      lat: 41.8,
      lon: 1.5,
      boundingBox: [40.5, 42.9, 0.1, 3.3],
      geojson: square,
    });
  });

  test("tolerates a response with no optional blocks", () => {
    const parsed = parsePlace({ display_name: "X", lat: "1", lon: "2" });
    expect(parsed?.nameEn).toBeNull();
    expect(parsed?.boundingBox).toBeNull();
    expect(parsed?.geojson).toBeNull();
  });

  test("rejects a row missing coordinates rather than yielding NaN", () => {
    expect(parsePlace({ display_name: "X" })).toBeNull();
    expect(parsePlace({ display_name: "X", lat: "nope", lon: "2" })).toBeNull();
    expect(parsePlace("not an object")).toBeNull();
  });
});

describe("matchesExactName", () => {
  test("matches the native name, case- and space-insensitively", () => {
    expect(matchesExactName(place({ name: "Catalunya" }), " catalunya ")).toBe(true);
  });

  test("matches the English and Danish names too", () => {
    const p = place({ name: "Россия", nameEn: "Russia", nameDa: "Rusland" });
    expect(matchesExactName(p, "russia")).toBe(true);
    expect(matchesExactName(p, "rusland")).toBe(true);
  });

  test("rejects a prefix, which is how Nominatim itself matches", () => {
    // "cat" prefix-matches Catalunya at the API. Accepting that would make
    // every photo taken in Barcelona a result for "cat".
    expect(matchesExactName(place({ name: "Catalunya" }), "cat")).toBe(false);
  });
});

describe("containsPoint", () => {
  test("returns null when there is no polygon to test", () => {
    expect(containsPoint(place(), 5, 5)).toBeNull();
  });

  test("tests a simple polygon", () => {
    const p = place({ geojson: square });
    expect(containsPoint(p, 5, 5)).toBe(true);
    expect(containsPoint(p, 20, 20)).toBe(false);
  });

  test("treats rings after the first as holes", () => {
    const p = place({ geojson: squareWithHole });
    expect(containsPoint(p, 5, 5)).toBe(false);
    expect(containsPoint(p, 1, 1)).toBe(true);
  });

  test("accepts a point inside any member of a MultiPolygon", () => {
    const p = place({
      geojson: {
        type: "MultiPolygon",
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
          [[[50, 50], [60, 50], [60, 60], [50, 60], [50, 50]]],
        ],
      },
    });
    expect(containsPoint(p, 55, 55)).toBe(true);
    expect(containsPoint(p, 25, 25)).toBe(false);
  });

  test("excludes a point the bounding box alone would accept", () => {
    // The antimeridian case. Nominatim reports Russia's box as the full
    // -180..180, which the bbox pre-filter reads as "any longitude,
    // latitude 41-82" -- most of populated Canada included. The polygon is
    // what actually decides.
    const russiaish = place({
      boundingBox: [41, 82, -180, 180],
      geojson: {
        type: "MultiPolygon",
        coordinates: [[[[20, 50], [180, 50], [180, 80], [20, 80], [20, 50]]]],
      },
    });
    expect(containsPoint(russiaish, 60, 100)).toBe(true);
    expect(containsPoint(russiaish, 60, -110)).toBe(false); // Alberta
  });

  test("returns null for geometry with no area", () => {
    expect(containsPoint(place({ geojson: { type: "Point", coordinates: [1, 2] } }), 1, 2)).toBeNull();
  });

  test("returns false, not null, for a MultiPolygon whose members are all malformed", () => {
    // Geometry is present but unparseable -- that must exclude the point
    // rather than fall back to trusting the bounding box.
    const p = place({
      geojson: {
        type: "MultiPolygon",
        coordinates: ["not a polygon", [], [["not a ring"]]],
      },
    });
    expect(containsPoint(p, 5, 5)).toBe(false);
  });
});

describe("searchNominatim", () => {
  test("sends the documented query and no headers at all", async () => {
    let seen: Request | undefined;
    const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
      seen = new Request(input as never, init);
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    await searchNominatim("denmark", { fetchImpl });

    const url = new URL(seen!.url);
    expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/search");
    expect(url.searchParams.get("q")).toBe("denmark");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("polygon_geojson")).toBe("1");
    expect(url.searchParams.get("namedetails")).toBe("1");
    expect(url.searchParams.get("polygon_threshold")).toBe("0.01");
    expect(url.searchParams.get("addressdetails")).toBeNull();
    // No custom header may be set: Nominatim's OPTIONS returns 302, so any
    // header that provokes a preflight makes the request fail outright.
    expect([...seen!.headers.keys()]).toEqual([]);
  });

  test("passes addressdetails and accept-language as query parameters", async () => {
    let seen: Request | undefined;
    const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
      seen = new Request(input as never, init);
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    await searchNominatim("denmark", { addressDetails: true, acceptLanguage: "en", fetchImpl });

    const url = new URL(seen!.url);
    expect(url.searchParams.get("addressdetails")).toBe("1");
    expect(url.searchParams.get("accept-language")).toBe("en");
    expect([...seen!.headers.keys()]).toEqual([]);
  });

  test("drops unparseable rows instead of failing the whole response", async () => {
    const body = JSON.stringify([
      { display_name: "Good", lat: "1", lon: "2" },
      { display_name: "Bad" },
    ]);
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const places = await searchNominatim("x", { fetchImpl });
    expect(places).toHaveLength(1);
    expect(places[0]?.displayName).toBe("Good");
  });

  test("returns an empty list on a non-200, a bad body, or a thrown fetch", async () => {
    const status = (async () => new Response("[]", { status: 503 })) as unknown as typeof fetch;
    expect(await searchNominatim("x", { fetchImpl: status })).toEqual([]);

    const garbage = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    expect(await searchNominatim("x", { fetchImpl: garbage })).toEqual([]);

    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await searchNominatim("x", { fetchImpl: boom })).toEqual([]);
  });

  test("returns an empty list when the body is not an array", async () => {
    const fetchImpl = (async () => new Response('{"error":"x"}', { status: 200 })) as unknown as typeof fetch;
    expect(await searchNominatim("x", { fetchImpl })).toEqual([]);
  });
});
