import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeModel } from '../src/rbx/binary.js';
import { decompressBlock } from '../src/util/lz4.js';
import { Instance } from '../src/rbx/instance.js';
import { v3 } from '../src/rbx/datatypes.js';

// These tests pin the exact on-disk encoding against an independent
// reimplementation of rbx-dom's transforms. A self-consistent bug (e.g. an
// inverted float bit-rotation) round-trips against our own decoder but fails
// here and against real readers.

function refInterleaveF32(values) {
  const n = values.length;
  const out = new Uint8Array(n * 4);
  values.forEach((v, i) => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v);
    const bits = new DataView(buf).getUint32(0);
    const rotated = ((bits << 1) | (bits >>> 31)) >>> 0; // rotate_left(1)
    const be = new Uint8Array(4);
    new DataView(be.buffer).setUint32(0, rotated);
    for (let k = 0; k < 4; k++) out[i + k * n] = be[k];
  });
  return out;
}

function refInterleaveI32(values) {
  const n = values.length;
  const out = new Uint8Array(n * 4);
  values.forEach((v, i) => {
    const zig = ((v << 1) ^ (v >> 31)) | 0;
    const be = new Uint8Array(4);
    new DataView(be.buffer).setInt32(0, zig);
    for (let k = 0; k < 4; k++) out[i + k * n] = be[k];
  });
  return out;
}

/** Parse the top-level chunk list of a serialized model. */
function chunks(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  const out = [];
  // header: 8 magic + 6 signature + 2 version + 4 classes + 4 instances + 8 reserved
  let off = 32;
  while (off + 16 <= buf.length) {
    const name = dec.decode(buf.subarray(off, off + 4));
    const compressedLen = dv.getUint32(off + 4, true);
    const rawLen = dv.getUint32(off + 8, true);
    const data =
      compressedLen === 0
        ? buf.subarray(off + 16, off + 16 + rawLen)
        : decompressBlock(buf.subarray(off + 16, off + 16 + compressedLen), rawLen);
    out.push({ name, data });
    off += 16 + (compressedLen === 0 ? rawLen : compressedLen);
    if (name.startsWith('END')) break;
  }
  return out;
}

function propChunk(list, propName) {
  const dec = new TextDecoder();
  for (const c of list) {
    if (!c.name.startsWith('PROP')) continue;
    const dv = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
    const nameLen = dv.getUint32(4, true);
    const name = dec.decode(c.data.subarray(8, 8 + nameLen));
    if (name === propName) return c.data.subarray(8 + nameLen);
  }
  return null;
}

test('header matches the documented rbx magic and layout', () => {
  const part = new Instance('Part', 'P');
  const buf = serializeModel([part]);
  assert.equal(new TextDecoder().decode(buf.subarray(0, 8)), '<roblox!');
  assert.deepEqual(Array.from(buf.subarray(8, 14)), [0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(dv.getUint16(14, true), 0); // version
});

test('Vector3 arrays use rbx-dom interleaved rotate_left(1) f32 encoding', () => {
  const part = new Instance('Part', 'P');
  part.set('Size', v3(4, 12, 4));
  const payload = propChunk(chunks(serializeModel([part])), 'size');
  assert.ok(payload, 'expected a "size" property chunk');

  assert.equal(payload[0], 0x0e, 'binary type should be Vector3 (0x0e)');
  const values = payload.subarray(1);

  const expected = new Uint8Array([
    ...refInterleaveF32([4]),
    ...refInterleaveF32([12]),
    ...refInterleaveF32([4]),
  ]);
  assert.deepEqual(Array.from(values), Array.from(expected));

  // Golden vector: 4.0 -> bits 0x40800000 -> rotate_left(1) -> 0x81000000.
  assert.deepEqual(Array.from(refInterleaveF32([4])), [0x81, 0x00, 0x00, 0x00]);
});

test('CFrame rotation id and position encoding', () => {
  const part = new Instance('Part', 'P');
  part.set('CFrame', { position: { x: 0, y: 6.5, z: 0 }, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  const payload = propChunk(chunks(serializeModel([part])), 'CFrame');
  assert.ok(payload);
  assert.equal(payload[0], 0x10, 'binary type should be CFrame (0x10)');
  assert.equal(payload[1], 0x02, 'identity rotation should use basic rotation id 0x02');
  const positions = payload.subarray(2);
  const expected = new Uint8Array([
    ...refInterleaveF32([0]),
    ...refInterleaveF32([6.5]),
    ...refInterleaveF32([0]),
  ]);
  assert.deepEqual(Array.from(positions), Array.from(expected));
});

test('Int32 arrays use zigzag then big-endian, transposed', () => {
  const a = new Instance('Part', 'A');
  const b = new Instance('Part', 'B');
  a.set('CollisionGroupId', 1);
  b.set('CollisionGroupId', -1);
  const payload = propChunk(chunks(serializeModel([a, b])), 'CollisionGroupId');
  assert.ok(payload);
  assert.equal(payload[0], 0x03, 'binary type should be Int32 (0x03)');
  assert.deepEqual(
    Array.from(payload.subarray(1)),
    Array.from(refInterleaveI32([1, -1])),
  );
  // zigzag: 1 -> 2, -1 -> 1
  assert.deepEqual(
    Array.from(refInterleaveI32([1, -1])),
    // transposed: byte k of value i lands at i + k*2
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01],
  );
});

test('patched serialized names appear verbatim in the file', () => {
  const part = new Instance('Part', 'P');
  part.set('Size', v3(1, 1, 1));
  part.set('Color', { r: 1, g: 0, b: 0 });
  const list = chunks(serializeModel([part]));
  assert.ok(propChunk(list, 'size'), 'Size must be written as "size"');
  assert.ok(propChunk(list, 'Color'), 'Color must keep its name');
  assert.equal(propChunk(list, 'Size'), null, 'canonical name must not be written');
});

test('END chunk carries the documented footer', () => {
  const list = chunks(serializeModel([new Instance('Folder', 'F')]));
  const end = list.find((c) => c.name.startsWith('END'));
  assert.ok(end);
  assert.equal(new TextDecoder().decode(end.data), '</roblox>');
});

