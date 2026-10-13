// Minimal, dependency-free LZ4 block codec.
//
// The Roblox binary model format (rbxm/rbxl) optionally wraps each chunk in an
// LZ4 *block* (not the LZ4 frame format). We only need block-level support.
//
// - decompressBlock: full LZ4 block decoder (handles all sequences).
// - compressBlock: emits a valid literal-only LZ4 block. It is not optimal, but
//   it round-trips through every conformant decoder (including rbx-dom). This
//   keeps us free of native dependencies while remaining 100% format-correct.

/**
 * Decompress a raw LZ4 block.
 * @param {Uint8Array} src compressed bytes
 * @param {number} destLen expected decompressed length
 * @returns {Uint8Array}
 */
export function decompressBlock(src, destLen) {
  const dst = new Uint8Array(destLen);
  let s = 0;
  let d = 0;
  const sLen = src.length;

  while (s < sLen) {
    const token = src[s++];
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b;
      do {
        b = src[s++];
        litLen += b;
      } while (b === 255);
    }

    if (litLen > 0) {
      if (d + litLen > destLen) throw new Error('lz4: literal run overflows output');
      dst.set(src.subarray(s, s + litLen), d);
      s += litLen;
      d += litLen;
    }

    // Last sequence contains literals only; no offset follows.
    if (s >= sLen) break;

    if (s + 2 > sLen) throw new Error('lz4: truncated match offset');
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0) throw new Error('lz4: zero match offset');

    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let b;
      do {
        b = src[s++];
        matchLen += b;
      } while (b === 255);
    }
    matchLen += 4; // minimum match length

    let from = d - offset;
    if (from < 0) throw new Error('lz4: match offset precedes output start');
    if (d + matchLen > destLen) throw new Error('lz4: match overflows output');
    // Byte-by-byte copy is required: matches may overlap the write cursor.
    for (let i = 0; i < matchLen; i++) dst[d + i] = dst[from + i];
    d += matchLen;
  }

  if (d !== destLen) {
    throw new Error(`lz4: decompressed ${d} bytes, expected ${destLen}`);
  }
  return dst;
}

/**
 * Produce a valid literal-only LZ4 block.
 * @param {Uint8Array} src
 * @returns {Uint8Array}
 */
export function compressBlock(src) {
  const n = src.length;
  const out = [];
  // Token: literal length nibble (extended below), match length nibble = 0.
  let token = Math.min(n, 15) << 4;
  out.push(token);
  if (n >= 15) {
    let rem = n - 15;
    while (rem >= 255) {
      out.push(255);
      rem -= 255;
    }
    out.push(rem);
  }
  for (let i = 0; i < n; i++) out.push(src[i]);
  return Uint8Array.from(out);
}
