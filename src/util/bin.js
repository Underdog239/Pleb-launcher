// Little-endian binary reader/writer primitives used by the rbx binary format.

export class ByteReader {
  /** @param {Uint8Array} buf */
  constructor(buf) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.off = 0;
  }

  get remaining() {
    return this.buf.length - this.off;
  }

  need(n) {
    if (this.off + n > this.buf.length) {
      throw new Error(`rbx: unexpected end of buffer at ${this.off} (need ${n})`);
    }
  }

  u8() {
    this.need(1);
    return this.buf[this.off++];
  }

  i8() {
    this.need(1);
    return this.view.getInt8(this.off++);
  }

  i16() {
    this.need(2);
    const v = this.view.getInt16(this.off, true);
    this.off += 2;
    return v;
  }

  u16() {
    this.need(2);
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }

  u32() {
    this.need(4);
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }

  i32() {
    this.need(4);
    const v = this.view.getInt32(this.off, true);
    this.off += 4;
    return v;
  }

  /** 64-bit value returned as a JS number (safe for counts/ids we handle). */
  u64() {
    this.need(8);
    const lo = this.view.getUint32(this.off, true);
    const hi = this.view.getUint32(this.off + 4, true);
    this.off += 8;
    return hi * 0x100000000 + lo;
  }

  f32() {
    this.need(4);
    const v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return v;
  }

  f64() {
    this.need(8);
    const v = this.view.getFloat64(this.off, true);
    this.off += 8;
    return v;
  }

  bytes(n) {
    this.need(n);
    const v = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return v;
  }

  /** Length-prefixed (u32) UTF-8 string. */
  string() {
    const len = this.u32();
    return new TextDecoder().decode(this.bytes(len));
  }
}

export class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  _push(buf) {
    this.chunks.push(buf);
    this.length += buf.length;
  }

  u8(v) {
    this._push(Uint8Array.of(v & 0xff));
  }

  i8(v) {
    const b = new Uint8Array(1);
    new DataView(b.buffer).setInt8(0, v);
    this._push(b);
  }

  _num(size, method, v) {
    const b = new Uint8Array(size);
    new DataView(b.buffer)[method](0, v, true);
    this._push(b);
  }

  u16(v) {
    this._num(2, 'setUint16', v);
  }

  u32(v) {
    this._num(4, 'setUint32', v >>> 0);
  }

  i32(v) {
    this._num(4, 'setInt32', v | 0);
  }

  i16(v) {
    this._num(2, 'setInt16', v | 0);
  }

  u64(v) {
    this._num(8, 'setBigUint64', BigInt(v));
  }

  f32(v) {
    this._num(4, 'setFloat32', v);
  }

  f64(v) {
    this._num(8, 'setFloat64', v);
  }

  bytes(buf) {
    this._push(buf instanceof Uint8Array ? buf : Uint8Array.from(buf));
  }

  string(s) {
    const enc = new TextEncoder().encode(s);
    this.u32(enc.length);
    this._push(enc);
  }

  toBytes() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}
