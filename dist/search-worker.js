(() => {
  // src/search/tokenize.ts
  function normalize(text) {
    return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  // src/search/suggest.ts
  var EMBEDDING_MODEL = "gemini-embedding-001";

  // src/search/import.ts
  var DIMENSIONS = 768;
  function rows(db, sql) {
    const stmt = db.prepare(sql);
    const out = [];
    try {
      while (stmt.step())
        out.push(stmt.get());
    } finally {
      stmt.free();
    }
    return out;
  }
  function buildIndex(db) {
    const keys = [];
    const keyIndex = new Map;
    for (const row of rows(db, "SELECT id FROM remote_asset_entity WHERE deleted_at IS NULL ORDER BY id")) {
      const key = String(row[0]);
      keyIndex.set(key, keys.length);
      keys.push(key);
    }
    const byTerm = new Map;
    for (const row of rows(db, `SELECT DISTINCT LOWER(l.label) AS term, l.asset_id
       FROM asset_label_entity l
       JOIN remote_asset_entity r ON r.id = l.asset_id
      WHERE r.deleted_at IS NULL`)) {
      const term = String(row[0]);
      const at = keyIndex.get(String(row[1]));
      if (at === undefined)
        continue;
      const list = byTerm.get(term);
      if (list === undefined)
        byTerm.set(term, [at]);
      else
        list.push(at);
    }
    const labelTerms = [...byTerm.keys()].sort();
    const labelOffsets = new Uint32Array(labelTerms.length + 1);
    let total = 0;
    for (let t = 0;t < labelTerms.length; t++) {
      labelOffsets[t] = total;
      total += byTerm.get(labelTerms[t]).length;
    }
    labelOffsets[labelTerms.length] = total;
    const labelPostings = new Uint32Array(total);
    let cursor = 0;
    for (const term of labelTerms) {
      for (const at of byTerm.get(term))
        labelPostings[cursor++] = at;
    }
    const ocrKeyList = [];
    const ocrText = [];
    for (const row of rows(db, `SELECT f.c0 AS asset_id, f.c1 AS ocr_text
       FROM asset_fts_content f
       JOIN remote_asset_entity r ON r.id = f.c0
      WHERE r.deleted_at IS NULL AND f.c1 IS NOT NULL AND f.c1 <> ''`)) {
      const at = keyIndex.get(String(row[0]));
      if (at === undefined)
        continue;
      const text = normalize(String(row[1]));
      if (text === "")
        continue;
      ocrKeyList.push(at);
      ocrText.push(text);
    }
    const geoKeyList = [];
    const lats = [];
    const lons = [];
    for (const row of rows(db, `SELECT e.asset_id, e.latitude, e.longitude
       FROM remote_exif_entity e
       JOIN remote_asset_entity r ON r.id = e.asset_id
      WHERE r.deleted_at IS NULL
        AND e.latitude IS NOT NULL AND e.longitude IS NOT NULL`)) {
      const at = keyIndex.get(String(row[0]));
      if (at === undefined)
        continue;
      const lat = Number(row[1]);
      const lon = Number(row[2]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon))
        continue;
      geoKeyList.push(at);
      lats.push(lat);
      lons.push(lon);
    }
    const live = new Set(labelTerms);
    const embeddingLabels = [];
    const vectorChunks = [];
    for (const row of rows(db, `SELECT label, embedding FROM label_embedding_entity
      WHERE model = '${EMBEDDING_MODEL}'`)) {
      const label = String(row[0]).toLowerCase();
      if (!live.has(label))
        continue;
      const blob = row[1];
      if (!(blob instanceof Uint8Array) || blob.length !== DIMENSIONS * 4)
        continue;
      const vector = new Float32Array(DIMENSIONS);
      new Uint8Array(vector.buffer).set(blob);
      embeddingLabels.push(label);
      vectorChunks.push(vector);
    }
    const vectors = new Float32Array(embeddingLabels.length * DIMENSIONS);
    vectorChunks.forEach((chunk, i) => vectors.set(chunk, i * DIMENSIONS));
    const keyRows = rows(db, "SELECT string_value FROM store_entity WHERE id = 2002");
    const rawKey = keyRows[0]?.[0];
    const apiKey = typeof rawKey === "string" && rawKey !== "" ? rawKey : null;
    return {
      index: {
        keys,
        labelTerms,
        labelOffsets,
        labelPostings,
        ocrKeys: Uint32Array.from(ocrKeyList),
        ocrText,
        geoKeys: Uint32Array.from(geoKeyList),
        geoLat: Float64Array.from(lats),
        geoLon: Float64Array.from(lons)
      },
      embeddings: {
        labels: embeddingLabels,
        vectors,
        dims: DIMENSIONS,
        model: EMBEDDING_MODEL
      },
      apiKey
    };
  }

  // src/search/gunzip.ts
  var GZIP_MAGIC_0 = 31;
  var GZIP_MAGIC_1 = 139;
  async function maybeGunzip(bytes) {
    if (bytes.length < 2 || bytes[0] !== GZIP_MAGIC_0 || bytes[1] !== GZIP_MAGIC_1) {
      return bytes;
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  // src/search/worker.ts
  var ctx = self;
  importScripts("./sql-wasm.js");
  ctx.onmessage = (event) => {
    run(event.data.url);
  };
  async function run(url) {
    try {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`snapshot download failed: HTTP ${response.status}`);
      const bytes = await download(response);
      const db = new (await initSqlJs({ locateFile: (file) => file })).Database(await maybeGunzip(bytes));
      try {
        ctx.postMessage({ type: "done", result: buildIndex(db) });
      } finally {
        db.close();
      }
    } catch (error) {
      ctx.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  async function download(response) {
    const total = Number(response.headers.get("content-length") ?? 0);
    const reader = response.body?.getReader();
    if (reader === undefined)
      return new Uint8Array(await response.arrayBuffer());
    const chunks = [];
    let loaded = 0;
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      chunks.push(value);
      loaded += value.length;
      ctx.postMessage({ type: "progress", loaded, total });
    }
    const out = new Uint8Array(loaded);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
})();
