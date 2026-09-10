(() => {
  // src/search/tokenize.ts
  function normalize(text) {
    return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  // src/search/suggest.ts
  var EMBEDDING_MODEL = "gemini-embedding-001";

  // src/search/local.ts
  var INDEX_FORMAT = 2;

  // src/search/import.ts
  var DIMENSIONS = 768;
  var RENDERABLE = "remote_key <> '' AND visibility = 0";
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
    for (const row of rows(db, `SELECT remote_key FROM gallery_asset WHERE ${RENDERABLE} ORDER BY remote_key`)) {
      const key = String(row[0]);
      if (keyIndex.has(key))
        continue;
      keyIndex.set(key, keys.length);
      keys.push(key);
    }
    const byTerm = new Map;
    for (const row of rows(db, `SELECT remote_key, name_normalized, label_text, camera_text, ocr_text
       FROM gallery_asset WHERE ${RENDERABLE}`)) {
      const at = keyIndex.get(String(row[0]));
      if (at === undefined)
        continue;
      const tokens = new Set;
      for (let column = 1;column <= 4; column++) {
        const value = row[column];
        if (value === null || value === undefined)
          continue;
        const text = normalize(String(value));
        if (text === "")
          continue;
        for (const token of text.split(" "))
          tokens.add(token);
      }
      for (const token of tokens) {
        const list = byTerm.get(token);
        if (list === undefined)
          byTerm.set(token, [at]);
        else
          list.push(at);
      }
    }
    const terms = [...byTerm.keys()].sort();
    const offsets = new Uint32Array(terms.length + 1);
    let total = 0;
    for (let t = 0;t < terms.length; t++) {
      offsets[t] = total;
      total += byTerm.get(terms[t]).length;
    }
    offsets[terms.length] = total;
    const postings = new Uint32Array(total);
    let cursor = 0;
    for (const term of terms) {
      for (const at of byTerm.get(term).sort((a, b) => a - b))
        postings[cursor++] = at;
    }
    const geoKeyList = [];
    const lats = [];
    const lons = [];
    for (const row of rows(db, `SELECT remote_key, latitude, longitude FROM gallery_asset
      WHERE ${RENDERABLE} AND has_location = 1`)) {
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
    const live = new Set;
    for (const row of rows(db, `SELECT DISTINCT LOWER(l.label) FROM gallery_label l
       JOIN gallery_asset a ON a.checksum = l.checksum
      WHERE a.remote_key <> '' AND a.visibility = 0`)) {
      live.add(String(row[0]));
    }
    const embeddingLabels = [];
    const vectorChunks = [];
    for (const row of rows(db, `SELECT label, embedding FROM label_embedding WHERE model = '${EMBEDDING_MODEL}'`)) {
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
    let apiKey = null;
    const hasStore = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'store_entity'");
    if (hasStore.length > 0) {
      const keyRows = rows(db, "SELECT string_value FROM store_entity WHERE id = 2002");
      const rawKey = keyRows[0]?.[0];
      if (typeof rawKey === "string" && rawKey !== "")
        apiKey = rawKey;
    }
    return {
      index: {
        format: INDEX_FORMAT,
        keys,
        terms,
        offsets,
        postings,
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
