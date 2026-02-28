/**
 * Compression and quantization utilities for V2 storage optimizations.
 *
 * - zlib: chunk text stored as BLOB instead of TEXT (3-5x smaller)
 * - int8: vectors quantized from float32 to int8 (4x smaller)
 * - SHA-256: stored as raw BLOB instead of hex string (2x smaller)
 *
 * All functions are synchronous (used inside better-sqlite3 transactions).
 */

import { deflateSync, inflateSync } from 'node:zlib';

// ── Text Compression ────────────────────────────────────────────────────────

/** Compress a UTF-8 string to a zlib BLOB for storage. */
export function compressText(text: string): Buffer {
  return deflateSync(Buffer.from(text, 'utf-8'));
}

/** Decompress a zlib BLOB back to a UTF-8 string. */
export function decompressText(buf: Buffer): string {
  return inflateSync(buf).toString('utf-8');
}

// ── Vector Quantization ─────────────────────────────────────────────────────

/**
 * Quantize a float vector to int8 for sqlite-vec int8[N] storage.
 *
 * Uses unit-norm quantization: assumes the input vector is L2-normalized
 * (which Arctic Embed produces), scales each dimension to [-128, 127].
 * sqlite-vec's int8 distance computation handles the rescaling internally.
 */
export function quantizeInt8(vec: number[]): Buffer {
  const int8 = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    int8[i] = Math.max(-128, Math.min(127, Math.round(vec[i] * 127)));
  }
  return Buffer.from(int8.buffer, int8.byteOffset, int8.byteLength);
}

/**
 * Convert a float vector to a Float32Array Buffer for sqlite-vec queries.
 * sqlite-vec MATCH accepts float32 query vectors even against int8 stored vectors.
 */
export function float32Buffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

// ── Content Hash ────────────────────────────────────────────────────────────

/** Convert a hex SHA-256 hash string to a raw 32-byte BLOB. */
export function hashToBlob(hexHash: string): Buffer {
  return Buffer.from(hexHash, 'hex');
}

/** Convert a raw 32-byte BLOB back to a hex SHA-256 hash string. */
export function blobToHash(buf: Buffer): string {
  return buf.toString('hex');
}
