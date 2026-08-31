/**
 * Place lookup against Nominatim, and the geometry that decides whether a
 * photo's GPS point falls inside the place it returned.
 *
 * Requests carry NO custom headers. Nominatim's OPTIONS returns a 302, so
 * any header that provokes a CORS preflight -- including the User-Agent the
 * reference implementation sets, which browsers forbid anyway -- makes the
 * request fail outright. The browser's own User-Agent and Referer satisfy
 * the usage policy.
 */

const ENDPOINT = "https://nominatim.openstreetmap.org/search";

export interface GeoJson {
  type: string;
  coordinates: unknown;
}

export interface NominatimPlace {
  displayName: string;
  /** The place's own name, in whatever language Nominatim considers native. */
  name: string | null;
  /** From `namedetails`; needed because `name` may be in another script. */
  nameEn: string | null;
  nameDa: string | null;
  /** From `address`; only present when the caller asked for addressdetails. */
  country: string | null;
  lat: number;
  lon: number;
  /** `[southLat, northLat, westLon, eastLon]`. */
  boundingBox: [number, number, number, number] | null;
  geojson: GeoJson | null;
}

export interface SearchOptions {
  addressDetails?: boolean;
  acceptLanguage?: string;
  fetchImpl?: typeof fetch;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** One row of Nominatim's response, or null if it can't be used. */
export function parsePlace(raw: unknown): NominatimPlace | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;

  const lat = Number(row["lat"]);
  const lon = Number(row["lon"]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const names = (row["namedetails"] ?? {}) as Record<string, unknown>;
  const address = (row["address"] ?? {}) as Record<string, unknown>;

  let boundingBox: [number, number, number, number] | null = null;
  const box = row["boundingbox"];
  if (Array.isArray(box) && box.length === 4) {
    const nums = box.map((v) => Number(v));
    if (nums.every((n) => Number.isFinite(n))) {
      boundingBox = [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
    }
  }

  const geo = row["geojson"];
  const geojson =
    typeof geo === "object" && geo !== null && typeof (geo as GeoJson).type === "string"
      ? (geo as GeoJson)
      : null;

  return {
    displayName: str(row["display_name"]) ?? "",
    name: str(row["name"]),
    nameEn: str(names["name:en"]),
    nameDa: str(names["name:da"]),
    country: str(address["country"]),
    lat,
    lon,
    boundingBox,
    geojson,
  };
}

/**
 * Whether [query] names this place exactly, in its native, English or Danish
 * name -- as opposed to merely prefix-matching it, which is how Nominatim's
 * own search behaves. Without this, "cat" resolves to Catalunya and every
 * photo geotagged in Barcelona becomes a result for it.
 */
export function matchesExactName(place: NominatimPlace, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return false;
  for (const candidate of [place.name, place.nameEn, place.nameDa]) {
    if (candidate !== null && candidate.trim().toLowerCase() === wanted) return true;
  }
  return false;
}

/**
 * Whether ([lat], [lon]) lies inside this place's polygon.
 *
 * Returns null when there is no area to test -- a point-like POI, or geometry
 * that wasn't requested -- and the caller should then trust the bounding box
 * alone.
 *
 * The bounding box is not sufficient on its own. For territory crossing the
 * antimeridian (Russia, Fiji) Nominatim reports the longitude range as the
 * full -180..180, because the shape touches both edges of the map. Nominatim
 * splits such shapes into separate rings precisely so a per-ring test works.
 */
export function containsPoint(place: NominatimPlace, lat: number, lon: number): boolean | null {
  const geo = place.geojson;
  if (geo === null) return null;

  if (geo.type === "Polygon") {
    return Array.isArray(geo.coordinates) ? inRings(lat, lon, geo.coordinates) : null;
  }
  if (geo.type === "MultiPolygon") {
    if (!Array.isArray(geo.coordinates)) return null;
    for (const polygon of geo.coordinates) {
      if (Array.isArray(polygon) && inRings(lat, lon, polygon)) return true;
    }
    return false;
  }
  return null;
}

/** First ring is the outline; the rest are holes. */
function inRings(lat: number, lon: number, rings: unknown[]): boolean {
  const outer = rings[0];
  if (!Array.isArray(outer)) return false;
  if (!inRing(lat, lon, outer)) return false;
  for (let i = 1; i < rings.length; i++) {
    const hole = rings[i];
    if (Array.isArray(hole) && inRing(lat, lon, hole)) return false;
  }
  return true;
}

/**
 * Ray-casting point-in-polygon. [ring] is a list of `[lon, lat]` pairs, and
 * is assumed not to cross the antimeridian itself -- true of Nominatim's
 * output, which splits multi-part shapes for exactly that reason.
 */
function inRing(lat: number, lon: number, ring: unknown[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    const xi = Number(a[0]);
    const yi = Number(a[1]);
    const xj = Number(b[0]);
    const yj = Number(b[1]);
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) {
      continue;
    }
    const crosses = yi > lat !== yj > lat;
    if (crosses && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Never throws. Returns an empty list on any failure. */
export async function searchNominatim(
  query: string,
  options: SearchOptions = {},
): Promise<NominatimPlace[]> {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    limit: "5",
    polygon_geojson: "1",
    namedetails: "1",
    // Simplification tolerance in degrees, roughly 1.1 km at the equator.
    // Large countries otherwise return tens of thousands of polygon points,
    // which is a slow parse for a question -- is this photo inside? -- that
    // a kilometre of border fuzz cannot affect.
    polygon_threshold: "0.01",
  });
  if (options.addressDetails === true) params.set("addressdetails", "1");
  if (options.acceptLanguage !== undefined) params.set("accept-language", options.acceptLanguage);

  const doFetch = options.fetchImpl ?? fetch;
  try {
    // No `headers` here, deliberately. See the note at the top of the file.
    const response = await doFetch(`${ENDPOINT}?${params.toString()}`);
    if (!response.ok) return [];
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return [];
    const places: NominatimPlace[] = [];
    for (const row of body) {
      const parsed = parsePlace(row);
      if (parsed !== null) places.push(parsed);
    }
    return places;
  } catch {
    return [];
  }
}
