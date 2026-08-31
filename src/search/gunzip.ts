/**
 * The snapshot is uploaded by `uploadFileGzipped`, which sets no
 * Content-Encoding -- so the bytes arrive still compressed and we decompress
 * them here. If a host ever stores it with Content-Encoding: gzip instead,
 * the browser will have decompressed it already. Sniffing the magic bytes
 * costs nothing and removes the assumption either way.
 */
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

export async function maybeGunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== GZIP_MAGIC_0 || bytes[1] !== GZIP_MAGIC_1) {
    return bytes;
  }

  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}
