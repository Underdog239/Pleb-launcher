// Roblox binary model codec (rbxm / rbxl).
//
// Implements the format documented in docs/binary-format.md. Chunks are written
// LZ4-compressed by default (matching Roblox) and read uncompressed, LZ4, or
// ZSTD-tagged transparently.

import { ByteReader, ByteWriter } from '../util/bin.js';
import { compressBlock, decompressBlock } from '../util/lz4.js';
import {
  Type,
  binaryTypeFor,
  transformI32,
  untransformI32,
  transformI64,
  untransformI64,
  rotateF32Bits,
  unrotateF32Bits,
} from './types.js';
import {
  propertiesFor,
  classInfo,
  isEnumValueType,
  serializationFor,
} from './reflection.js';
import { Instance } from './instance.js';
import { rotationFromId, rotationToId, IDENTITY_ROTATION } from './datatypes.js';

const MAGIC = Uint8Array.from([0x3c, 0x72, 0x6f, 0x62, 0x6c, 0x6f, 0x78, 0x21]); // "<roblox!"
const SIGNATURE = Uint8Array.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]);
const FOOTER = new TextEncoder().encode('</roblox>');
const FILE_VERSION = 0;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

const scratch = new DataView(new ArrayBuffer(8));
const f32bits = (v) => {
  scratch.setFloat32(0, v);
  return scratch.getUint32(0);
};
const bitsF32 = (b) => {
  scratch.setUint32(0, b);
  return scratch.getFloat32(0);
};

// --- interleaved array helpers ----------------------------------------------

function interleave(values, bytesPer, enc) {
  const n = values.length;
  const buf = new Uint8Array(n * bytesPer);
  for (let i = 0; i < n; i++) {
    const b = enc(values[i]);
    for (let k = 0; k < bytesPer; k++) buf[i + k * n] = b[k];
  }
  return buf;
}

function deinterleave(buf, count, bytesPer, dec) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const b = new Uint8Array(bytesPer);
    for (let k = 0; k < bytesPer; k++) b[k] = buf[i + k * count];
    out[i] = dec(b);
  }
  return out;
}

const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const encU32 = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, false);
  return b;
};
const encI32 = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, transformI32(v | 0), false);
  return b;
};
const encF32 = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, rotateF32Bits(f32bits(v)), false);
  return b;
};
const encI64 = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, transformI64(v)), false);
  return b;
};
const decU32 = (b) => dv(b).getUint32(0, false);
const decI32 = (b) => untransformI32(dv(b).getInt32(0, false));
const decF32 = (b) => bitsF32(unrotateF32Bits(dv(b).getUint32(0, false)));
const decI64 = (b) => Number(untransformI64(dv(b).getBigInt64(0, false)));

function delta(values) {
  let last = 0;
  return values.map((v) => {
    const d = v - last;
    last = v;
    return d;
  });
}

function undelta(values) {
  let last = 0;
  return values.map((v) => {
    last += v;
    return last;
  });
}

// --- chunk I/O --------------------------------------------------------------

function writeChunk(name, payload, compression) {
  const w = new ByteWriter();
  w.bytes(new TextEncoder().encode(name));
  if (compression === 'none') {
    w.u32(0);
    w.u32(payload.length);
    w.u32(0);
    w.bytes(payload);
  } else {
    const compressed = compressBlock(payload);
    w.u32(compressed.length);
    w.u32(payload.length);
    w.u32(0);
    w.bytes(compressed);
  }
  return w.toBytes();
}

function readChunkHeader(r) {
  const nameBytes = r.bytes(4);
  const name = new TextDecoder().decode(nameBytes);
  const compressedLen = r.u32();
  const uncompressedLen = r.u32();
  r.u32(); // reserved
  let data;
  if (compressedLen === 0) {
    data = r.bytes(uncompressedLen);
  } else {
    const compressed = r.bytes(compressedLen);
    const isZstd = ZSTD_MAGIC.every((b, i) => compressed[i] === b);
    if (isZstd) {
      throw new Error('rbx: ZSTD-compressed chunks are not supported');
    }
    data = decompressBlock(compressed, uncompressedLen);
  }
  return { name, data };
}

// --- property value encoding ------------------------------------------------

function encodeValues(w, binType, instances, propName, ctx, valueType = null) {
  const vals = instances.map((i) => i.props.get(propName));
  const num = (v) => (typeof v === 'number' ? v : 0);
  switch (binType) {
    case Type.String:
      for (const v of vals) {
        if (v == null) w.string('');
        else if (typeof v === 'string') w.string(v);
        else if (v instanceof Uint8Array) {
          w.u32(v.length);
          w.bytes(v);
        } else w.string(String(v));
      }
      break;
    case Type.Bool:
      for (const v of vals) w.u8(v ? 1 : 0);
      break;
    case Type.Int32:
      w.bytes(interleave(vals.map(num), 4, encI32));
      break;
    case Type.Float32:
      w.bytes(interleave(vals.map(num), 4, encF32));
      break;
    case Type.Float64:
      for (const v of vals) w.f64(num(v));
      break;
    case Type.UDim:
      w.bytes(interleave(vals.map((v) => (v ? num(v.scale) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v ? num(v.offset) : 0)), 4, encI32));
      break;
    case Type.UDim2:
      w.bytes(interleave(vals.map((v) => (v ? num(v.x.scale) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v ? num(v.y.scale) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v ? num(v.x.offset) : 0)), 4, encI32));
      w.bytes(interleave(vals.map((v) => (v ? num(v.y.offset) : 0)), 4, encI32));
      break;
    case Type.Color3:
      w.bytes(interleave(vals.map((v) => (v ? num(v.r) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v ? num(v.g) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v ? num(v.b) : 0)), 4, encF32));
      break;
    case Type.Color3uint8: {
      const scale = valueType === 'Color3' ? 255 : 1;
      const byte = (v, k) => (v ? Math.max(0, Math.min(255, Math.round(num(v[k]) * scale))) : 0);
      for (const v of vals) w.u8(byte(v, 'r'));
      for (const v of vals) w.u8(byte(v, 'g'));
      for (const v of vals) w.u8(byte(v, 'b'));
      break;
    }
    case Type.Vector2:
      w.bytes(interleave(vals.map((v) => (v ? num(v.x) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v ? num(v.y) : 0)), 4, encF32));
      break;
    case Type.Vector3:
      w.bytes(interleave(vals.map((v) => (v ? num(v.x) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v ? num(v.y) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v ? num(v.z) : 0)), 4, encF32));
      break;
    case Type.Vector3int16:
      for (const v of vals) {
        w.i16(v ? num(v.x) : 0);
        w.i16(v ? num(v.y) : 0);
        w.i16(v ? num(v.z) : 0);
      }
      break;
    case Type.CFrame:
    case Type.OptionalCFrame: {
      const isOpt = binType === Type.OptionalCFrame;
      if (isOpt) w.u8(Type.CFrame);
      const rotations = [];
      const bools = [];
      for (const v of vals) {
        if (v && v.rotation) {
          rotations.push(v.rotation);
          bools.push(1);
        } else {
          rotations.push(IDENTITY_ROTATION);
          bools.push(0);
        }
      }
      for (const rot of rotations) {
        const id = rotationToId(rot);
        if (id !== null) w.u8(id);
        else {
          w.u8(0);
          for (const f of rot) w.f32(f);
        }
      }
      w.bytes(interleave(vals.map((v) => (v && v.position ? num(v.position.x) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v && v.position ? num(v.position.y) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v && v.position ? num(v.position.z) : 0)), 4, encF32));
      if (isOpt) {
        w.u8(Type.Bool);
        for (const b of bools) w.u8(b);
      }
      break;
    }
    case Type.Ray:
      for (const v of vals) {
        w.f32(v && v.origin ? num(v.origin.x) : 0);
        w.f32(v && v.origin ? num(v.origin.y) : 0);
        w.f32(v && v.origin ? num(v.origin.z) : 0);
        w.f32(v && v.direction ? num(v.direction.x) : 0);
        w.f32(v && v.direction ? num(v.direction.y) : 0);
        w.f32(v && v.direction ? num(v.direction.z) : 0);
      }
      break;
    case Type.Faces:
    case Type.Axes:
      for (const v of vals) w.u8(num(v) & 0xff);
      break;
    case Type.BrickColor:
    case Type.Enum:
      w.bytes(interleave(vals.map(num), 4, encU32));
      break;
    case Type.Ref:
      w.bytes(
        interleave(
          delta(vals.map((v) => (v && ctx.referent.has(v) ? ctx.referent.get(v) : -1))),
          4,
          encI32,
        ),
      );
      break;
        case Type.NumberSequence:
      for (const v of vals) {
        const kps = (v && v.keypoints) || [];
        w.u32(kps.length);
        for (const kp of kps) {
          w.f32(num(kp.time));
          w.f32(num(kp.value));
          w.f32(num(kp.envelope));
        }
      }
      break;
    case Type.ColorSequence:
      for (const v of vals) {
        const kps = (v && v.keypoints) || [];
        w.u32(kps.length);
        for (const kp of kps) {
          w.f32(num(kp.time));
          w.f32(kp.color ? num(kp.color.r) : 0);
          w.f32(kp.color ? num(kp.color.g) : 0);
          w.f32(kp.color ? num(kp.color.b) : 0);
          w.f32(0);
        }
      }
      break;
    case Type.NumberRange:
      for (const v of vals) {
        w.f32(v ? num(v.min) : 0);
        w.f32(v ? num(v.max) : 0);
      }
      break;
    case Type.Rect:
      w.bytes(interleave(vals.map((v) => (v ? num(v.min.x) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v ? num(v.min.y) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v ? num(v.max.x) : 0)), 4, encF32));
      w.bytes(interleave(vals.map((v) => (v ? num(v.max.y) : 0)), 4, encF32));
      break;
    case Type.PhysicalProperties:
      for (const v of vals) {
        if (!v) {
          w.u8(0);
          continue;
        }
        const skipAcoustics = (v.acousticAbsorption ?? 1) === 1;
        w.u8(skipAcoustics ? 1 : 3);
        w.f32(num(v.density));
        w.f32(num(v.friction));
        w.f32(num(v.elasticity));
        w.f32(num(v.frictionWeight));
        w.f32(num(v.elasticityWeight));
        if (!skipAcoustics) w.f32(num(v.acousticAbsorption));
      }
      break;
    case Type.Int64:
      w.bytes(interleave(vals.map((v) => BigInt(v || 0)), 8, encI64));
      break;
    case Type.UniqueId:
      w.bytes(
        interleave(
          vals.map((v) => v || { index: 0, time: 0, random: 0 }),
          16,
          (v) => {
            const b = new Uint8Array(16);
            const d = new DataView(b.buffer);
            d.setUint32(0, v.index >>> 0, false);
            d.setUint32(4, v.time >>> 0, false);
            d.setUint32(8, v.random >>> 0, false);
            return b;
          },
        ),
      );
      break;
    case Type.SecurityCapabilities:
      w.bytes(interleave(vals.map((v) => BigInt(v || 0)), 8, encI64));
      break;
    case Type.Font:
      for (const v of vals) {
        const f = v || {};
        w.string(f.family || '');
        w.u16(f.weight || 0);
        w.u8(f.style || 0);
        w.string(f.cachedFaceId || '');
      }
      break;
    case Type.Content:
      encodeContent(w, vals, ctx);
      break;
    default:
      throw new Error(`rbx: unsupported binary property type 0x${binType.toString(16)}`);
  }
}

function encodeContent(w, vals, ctx) {
  const sourceTypes = [];
  const uris = [];
  const objects = [];
  for (const v of vals) {
    if (!v || v.source === 'none' || v == null) sourceTypes.push(0);
    else if (v.source === 'uri') {
      sourceTypes.push(1);
      uris.push(v.value);
    } else if (v.source === 'object') {
      sourceTypes.push(2);
      objects.push(ctx.referent.has(v.value) ? ctx.referent.get(v.value) : -1);
    } else sourceTypes.push(0);
  }
  w.bytes(interleave(sourceTypes, 4, encI32));
  w.u32(uris.length);
  for (const u of uris) w.string(u);
  w.u32(objects.length);
  w.bytes(interleave(delta(objects), 4, encI32));
  w.u32(0);
}

// --- serialization ----------------------------------------------------------

/**
 * Serialize root instances (with all descendants) to a binary rbxm/rbxl buffer.
 * @param {Instance[]} roots
 * @param {{compression?: 'lz4'|'none'}} [options]
 * @returns {Uint8Array}
 */
export function serializeModel(roots, options = {}) {
  const compression = options.compression || 'lz4';
  const all = [];
  const visit = (inst) => {
    all.push(inst);
    for (const c of inst.children) visit(c);
  };
  for (const r of roots) visit(r);

  const referent = new Map();
  all.forEach((inst, i) => referent.set(inst, i));

  const byClass = new Map();
  for (const inst of all) {
    if (!byClass.has(inst.className)) byClass.set(inst.className, []);
    byClass.get(inst.className).push(inst);
  }

  const typeIds = new Map();
  for (const inst of all) {
    if (!typeIds.has(inst.className)) typeIds.set(inst.className, typeIds.size);
  }

  const parts = [];
  const header = new ByteWriter();
  header.bytes(MAGIC);
  header.bytes(SIGNATURE);
  header.u16(FILE_VERSION);
  header.u32(typeIds.size);
  header.u32(all.length);
  header.bytes(new Uint8Array(8));
  parts.push(header.toBytes());

  for (const [className, instances] of byClass) {
    const info = classInfo(className);
    const isService = !!(info && info.service === 1);
    const w = new ByteWriter();
    w.u32(typeIds.get(className));
    w.string(className);
    w.u8(isService ? 1 : 0);
    w.u32(instances.length);
    w.bytes(interleave(delta(instances.map((i) => referent.get(i))), 4, encI32));
    if (isService) for (let i = 0; i < instances.length; i++) w.u8(1);
    parts.push(writeChunk('INST', w.toBytes(), compression));
  }

  const ctx = { referent, unsupported: new Set() };
  for (const [className, instances] of byClass) {
    const writeName = new ByteWriter();
    writeName.u32(typeIds.get(className));
    writeName.string('Name');
    writeName.u8(Type.String);
    for (const inst of instances) writeName.string(inst.name);
    parts.push(writeChunk('PROP', writeName.toBytes(), compression));

    const ser = serializationFor(className);
    const propNames = [...ser.forward.keys()].filter((n) => n !== 'Name').sort();
    for (const propName of propNames) {
      const { serializedName, valueType, canonicalType } = ser.forward.get(propName);
      const binType = binaryTypeFor(valueType, isEnumValueType(valueType) ? 'Enum' : null);
      if (binType === null) {
        ctx.unsupported.add(`${className}.${propName}:${valueType}`);
        continue;
      }
      const w = new ByteWriter();
      w.u32(typeIds.get(className));
      w.string(serializedName);
      w.u8(binType);
      encodeValues(w, binType, instances, propName, ctx, canonicalType);
      parts.push(writeChunk('PROP', w.toBytes(), compression));
    }
  }

  const prnt = new ByteWriter();
  prnt.u8(0);
  prnt.u32(all.length);
  prnt.bytes(interleave(delta(all.map((i) => referent.get(i))), 4, encI32));
  prnt.bytes(
    interleave(
      delta(all.map((i) => (i.parent && referent.has(i.parent) ? referent.get(i.parent) : -1))),
      4,
      encI32,
    ),
  );
  parts.push(writeChunk('PRNT', prnt.toBytes(), compression));

  parts.push(writeChunk('END\0', FOOTER, 'none'));

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export { MAGIC, SIGNATURE, FOOTER };

// --- deserialization --------------------------------------------------------

function readInterleaved(cr, count, bytesPer, dec) {
  return deinterleave(cr.bytes(count * bytesPer), count, bytesPer, dec);
}

function assign(inst, propName, value) {
  if (propName === 'Name') inst.name = value;
  else inst.props.set(propName, value);
}

function decodeValues(cr, binType, instances, propName, ctx, valueType = null) {
  const n = instances.length;
  const put = (arr) => instances.forEach((inst, i) => assign(inst, propName, arr[i]));

  switch (binType) {
    case Type.String:
      put(Array.from({ length: n }, () => cr.string()));
      break;
    case Type.Bool:
      put(Array.from({ length: n }, () => cr.u8() !== 0));
      break;
    case Type.Int32:
      put(readInterleaved(cr, n, 4, decI32));
      break;
    case Type.Float32:
      put(readInterleaved(cr, n, 4, decF32));
      break;
    case Type.Float64:
      put(Array.from({ length: n }, () => cr.f64()));
      break;
    case Type.UDim: {
      const s = readInterleaved(cr, n, 4, decF32);
      const o = readInterleaved(cr, n, 4, decI32);
      put(s.map((scale, i) => ({ scale, offset: o[i] })));
      break;
    }
    case Type.UDim2: {
      const sx = readInterleaved(cr, n, 4, decF32);
      const sy = readInterleaved(cr, n, 4, decF32);
      const ox = readInterleaved(cr, n, 4, decI32);
      const oy = readInterleaved(cr, n, 4, decI32);
      put(sx.map((v, i) => ({ x: { scale: v, offset: ox[i] }, y: { scale: sy[i], offset: oy[i] } })));
      break;
    }
    case Type.Color3: {
      const r = readInterleaved(cr, n, 4, decF32);
      const g = readInterleaved(cr, n, 4, decF32);
      const b = readInterleaved(cr, n, 4, decF32);
      put(r.map((v, i) => ({ r: v, g: g[i], b: b[i] })));
      break;
    }
    case Type.Color3uint8: {
      const r = Array.from({ length: n }, () => cr.u8());
      const g = Array.from({ length: n }, () => cr.u8());
      const b = Array.from({ length: n }, () => cr.u8());
      const scale = valueType === 'Color3' ? 1 / 255 : 1;
      put(r.map((v, i) => ({ r: v * scale, g: g[i] * scale, b: b[i] * scale })));
      break;
    }
    case Type.Vector2: {
      const x = readInterleaved(cr, n, 4, decF32);
      const y = readInterleaved(cr, n, 4, decF32);
      put(x.map((v, i) => ({ x: v, y: y[i] })));
      break;
    }
    case Type.Vector3: {
      const x = readInterleaved(cr, n, 4, decF32);
      const y = readInterleaved(cr, n, 4, decF32);
      const z = readInterleaved(cr, n, 4, decF32);
      put(x.map((v, i) => ({ x: v, y: y[i], z: z[i] })));
      break;
    }
    case Type.Vector3int16:
      put(Array.from({ length: n }, () => ({ x: cr.i16(), y: cr.i16(), z: cr.i16() })));
      break;
    case Type.CFrame:
    case Type.OptionalCFrame: {
      const isOpt = binType === Type.OptionalCFrame;
      if (isOpt) cr.u8();
      const rotations = [];
      for (let i = 0; i < n; i++) {
        const id = cr.u8();
        if (id === 0) {
          const m = new Array(9);
          for (let k = 0; k < 9; k++) m[k] = cr.f32();
          rotations.push(m);
        } else {
          rotations.push(rotationFromId(id) || [...IDENTITY_ROTATION]);
        }
      }
      const x = readInterleaved(cr, n, 4, decF32);
      const y = readInterleaved(cr, n, 4, decF32);
      const z = readInterleaved(cr, n, 4, decF32);
      const out = rotations.map((rotation, i) => ({
        position: { x: x[i], y: y[i], z: z[i] },
        rotation,
      }));
      if (isOpt) {
        cr.u8();
        const bools = Array.from({ length: n }, () => cr.u8());
        put(out.map((cf, i) => (bools[i] ? cf : null)));
      } else put(out);
      break;
    }
    case Type.Ray:
      put(
        Array.from({ length: n }, () => ({
          origin: { x: cr.f32(), y: cr.f32(), z: cr.f32() },
          direction: { x: cr.f32(), y: cr.f32(), z: cr.f32() },
        })),
      );
      break;
    case Type.Faces:
    case Type.Axes:
      put(Array.from({ length: n }, () => cr.u8()));
      break;
    case Type.BrickColor:
    case Type.Enum:
      put(readInterleaved(cr, n, 4, decU32));
      break;
    case Type.Ref: {
      const refs = undelta(readInterleaved(cr, n, 4, decI32));
      put(refs.map((r) => (r === -1 ? null : ctx.byReferent.get(r) || null)));
      break;
    }
    case Type.NumberSequence:
      put(
        Array.from({ length: n }, () => {
          const c = cr.u32();
          const keypoints = [];
          for (let k = 0; k < c; k++) {
            keypoints.push({ time: cr.f32(), value: cr.f32(), envelope: cr.f32() });
          }
          return { keypoints };
        }),
      );
      break;
    case Type.ColorSequence:
      put(
        Array.from({ length: n }, () => {
          const c = cr.u32();
          const keypoints = [];
          for (let k = 0; k < c; k++) {
            const time = cr.f32();
            const color = { r: cr.f32(), g: cr.f32(), b: cr.f32() };
            cr.f32();
            keypoints.push({ time, color });
          }
          return { keypoints };
        }),
      );
      break;
    case Type.NumberRange:
      put(Array.from({ length: n }, () => ({ min: cr.f32(), max: cr.f32() })));
      break;
    case Type.Rect: {
      const xmin = readInterleaved(cr, n, 4, decF32);
      const ymin = readInterleaved(cr, n, 4, decF32);
      const xmax = readInterleaved(cr, n, 4, decF32);
      const ymax = readInterleaved(cr, n, 4, decF32);
      put(xmin.map((v, i) => ({ min: { x: v, y: ymin[i] }, max: { x: xmax[i], y: ymax[i] } })));
      break;
    }
    case Type.PhysicalProperties:
      put(
        Array.from({ length: n }, () => {
          const flags = cr.u8();
          if (flags === 0) return null;
          const props = {
            density: cr.f32(),
            friction: cr.f32(),
            elasticity: cr.f32(),
            frictionWeight: cr.f32(),
            elasticityWeight: cr.f32(),
          };
          if (flags & 2) props.acousticAbsorption = cr.f32();
          return props;
        }),
      );
      break;
    case Type.Int64:
      put(readInterleaved(cr, n, 8, decI64));
      break;
    case Type.UniqueId: {
      const blobs = deinterleave(cr.bytes(n * 16), n, 16, (b) => b);
      put(
        blobs.map((b) => {
          const d = dv(b);
          return {
            index: d.getUint32(0, false),
            time: d.getUint32(4, false),
            random: d.getUint32(8, false),
          };
        }),
      );
      break;
    }
    case Type.SecurityCapabilities:
      put(readInterleaved(cr, n, 8, decI64));
      break;
    case Type.Font:
      put(
        Array.from({ length: n }, () => ({
          family: cr.string(),
          weight: cr.u16(),
          style: cr.u8(),
          cachedFaceId: cr.string(),
        })),
      );
      break;
    case Type.Content: {
      const sourceTypes = readInterleaved(cr, n, 4, decI32);
      const uriCount = cr.u32();
      const uris = Array.from({ length: uriCount }, () => cr.string());
      const objCount = cr.u32();
      const objs = undelta(readInterleaved(cr, objCount, 4, decI32));
      cr.u32();
      let ui = 0;
      let oi = 0;
      put(
        sourceTypes.map((st) => {
          if (st === 1) return { source: 'uri', value: uris[ui++] };
          if (st === 2) return { source: 'object', value: ctx.byReferent.get(objs[oi++]) || null };
          return { source: 'none' };
        }),
      );
      break;
    }
    default:
      throw new Error(`rbx: cannot decode binary property type 0x${binType.toString(16)}`);
  }
}


/**
 * Deserialize a binary rbxm/rbxl buffer into root instances.
 * @param {Uint8Array|Buffer} buffer
 * @returns {Instance[]} roots in referent order
 */
export function deserializeModel(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const r = new ByteReader(bytes);

  const magic = r.bytes(8);
  for (let i = 0; i < 8; i++) {
    if (magic[i] !== MAGIC[i]) throw new Error('rbx: not a Roblox binary file');
  }
  r.bytes(6); // signature
  r.u16(); // version
  r.u32(); // class count
  r.u32(); // instance count
  r.bytes(8); // reserved

  const byReferent = new Map();
  const byTypeId = new Map();
  const typeNames = new Map();
  const sharedStrings = [];

  while (r.remaining >= 16) {
    const { name, data } = readChunkHeader(r);
    const tag = name.slice(0, 3);

    if (tag === 'END') break;

    if (tag === 'INS') {
      const cr = new ByteReader(data);
      const typeId = cr.u32();
      const className = cr.string();
      const isService = cr.u8() !== 0;
      const count = cr.u32();
      const refs = undelta(deinterleave(cr.bytes(count * 4), count, 4, decI32));
      const list = [];
      for (const ref of refs) {
        const inst = new Instance(className);
        inst.isService = isService;
        byReferent.set(ref, inst);
        list.push(inst);
      }
      byTypeId.set(typeId, list);
      typeNames.set(typeId, className);
      if (isService) cr.bytes(count);
    } else if (tag === 'PRO') {
      const cr = new ByteReader(data);
      const typeId = cr.u32();
      const propName = cr.string();
      const binType = cr.u8();
      const instances = byTypeId.get(typeId);
      if (instances && instances.length > 0) {
        const className = typeNames.get(typeId);
        const rev = className ? serializationFor(className).reverse.get(propName) : null;
        const canonicalName = rev ? rev.canonicalName : propName;
        decodeValues(cr, binType, instances, canonicalName, { byReferent, sharedStrings }, rev ? rev.canonicalType : null);
      }
    } else if (tag === 'PRN') {
      const cr = new ByteReader(data);
      cr.u8();
      const count = cr.u32();
      const objs = undelta(deinterleave(cr.bytes(count * 4), count, 4, decI32));
      const pars = undelta(deinterleave(cr.bytes(count * 4), count, 4, decI32));
      for (let i = 0; i < count; i++) {
        const inst = byReferent.get(objs[i]);
        if (!inst) continue;
        inst.setParent(pars[i] === -1 ? null : byReferent.get(pars[i]) || null);
      }
    } else if (tag === 'SST') {
      const cr = new ByteReader(data);
      cr.u32();
      const count = cr.u32();
      for (let i = 0; i < count; i++) {
        cr.bytes(16);
        const len = cr.u32();
        sharedStrings.push(cr.bytes(len));
      }
    }
  }

  const roots = [];
  for (const inst of byReferent.values()) {
    if (!inst.parent) roots.push(inst);
  }
  return roots;
}

