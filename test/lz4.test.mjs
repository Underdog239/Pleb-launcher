import test from 'node:test';
import assert from 'node:assert/strict';
import { compressBlock, decompressBlock } from '../src/util/lz4.js';

test('decompresses a hand-built LZ4 block with a match', () => {
  // literals "abcd", then match at offset 4 length 4 -> "abcdabcd"
  const src = Uint8Array.from([0x40, 0x61, 0x62, 0x63, 0x64, 0x04, 0x00]);
  const out = decompressBlock(src, 8);
  assert.equal(new TextDecoder().decode(out), 'abcdabcd');
});

test('decompresses overlapping matches', () => {
  // literal "a", then match offset 1 length 7 -> "aaaaaaaa"
  const src = Uint8Array.from([0x13, 0x61, 0x01, 0x00]);
  const out = decompressBlock(src, 8);
  assert.equal(new TextDecoder().decode(out), 'aaaaaaaa');
});

test('decompresses extended literal lengths', () => {
  const payload = new Uint8Array(300).fill(0x41);
  const compressed = compressBlock(payload);
  const out = decompressBlock(compressed, payload.length);
  assert.deepEqual(out, payload);
});

test('compress/decompress round-trips arbitrary bytes', () => {
  for (const len of [0, 1, 14, 15, 16, 255, 256, 1000]) {
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) data[i] = (i * 37 + 11) & 0xff;
    const out = decompressBlock(compressBlock(data), len);
    assert.deepEqual(out, data, `len=${len}`);
  }
});

test('rejects a zero match offset', () => {
  const src = Uint8Array.from([0x00, 0x00, 0x00]);
  assert.throws(() => decompressBlock(src, 4), /zero match offset/);
});
