// Roblox binary model format: property type IDs and value transforms.
//
// IDs and encodings verified against rbx-dom (rbx_binary/src/types.rs and
// serializer/state.rs). See docs/binary-format.md for the full writeup.

export const Type = {
  String: 0x01,
  Bool: 0x02,
  Int32: 0x03,
  Float32: 0x04,
  Float64: 0x05,
  UDim: 0x06,
  UDim2: 0x07,
  Ray: 0x08,
  Faces: 0x09,
  Axes: 0x0a,
  BrickColor: 0x0b,
  Color3: 0x0c,
  Vector2: 0x0d,
  Vector3: 0x0e,
  CFrame: 0x10,
  Enum: 0x12,
  Ref: 0x13,
  Vector3int16: 0x14,
  NumberSequence: 0x15,
  ColorSequence: 0x16,
  NumberRange: 0x17,
  Rect: 0x18,
  PhysicalProperties: 0x19,
  Color3uint8: 0x1a,
  Int64: 0x1b,
  SharedString: 0x1c,
  OptionalCFrame: 0x1e,
  UniqueId: 0x1f,
  Font: 0x20,
  SecurityCapabilities: 0x21,
  Content: 0x22,
};

export const TypeName = Object.fromEntries(
  Object.entries(Type).map(([k, v]) => [v, k]),
);

// Maps API-dump value type names onto binary property types.
// Anything not listed here is treated as unsupported for binary output.
const VALUE_TYPE_TO_BINARY = {
  bool: Type.Bool,
  int: Type.Int32,
  int64: Type.Int64,
  float: Type.Float32,
  double: Type.Float64,
  string: Type.String,
  BinaryString: Type.String,
  ContentId: Type.String,
  ProtectedString: Type.String,
  Content: Type.Content,
  Vector2: Type.Vector2,
  Vector3: Type.Vector3,
  Vector3int16: Type.Vector3int16,
  CFrame: Type.CFrame,
  Color3: Type.Color3,
  Color3uint8: Type.Color3uint8,
  UDim: Type.UDim,
  UDim2: Type.UDim2,
  Ray: Type.Ray,
  Faces: Type.Faces,
  Axes: Type.Axes,
  BrickColor: Type.BrickColor,
  NumberSequence: Type.NumberSequence,
  ColorSequence: Type.ColorSequence,
  NumberRange: Type.NumberRange,
  Rect: Type.Rect,
  PhysicalProperties: Type.PhysicalProperties,
  Font: Type.Font,
  SecurityCapabilities: Type.SecurityCapabilities,
  UniqueId: Type.UniqueId,
  SharedString: Type.SharedString,
  Instance: Type.Ref,
};

/**
 * Resolve the binary property type for a value-type name.
 * Enum value types arrive as { category: 'Enum', name } and map to Type.Enum.
 * @param {string} valueType
 * @param {string|null} category
 * @returns {number|null}
 */
export function binaryTypeFor(valueType, category = null) {
  if (category === 'Enum') return Type.Enum;
  return VALUE_TYPE_TO_BINARY[valueType] ?? null;
}

/**
 * Can a value of this type be written to the binary format at all?
 *
 * This exists so a property that would be dropped can be reported *before* the
 * file is written. A type missing from the table means the binary writer has no
 * encoding for it; silently omitting it is how a model looks fine and is wrong.
 */
export function isBinarySerializable(valueType, category = null) {
  return binaryTypeFor(valueType, category) !== null;
}

/** Every value type the binary writer knows how to encode. */
export const binaryValueTypes = Object.freeze(Object.keys(VALUE_TYPE_TO_BINARY));

/** Zigzag-encode a 32-bit signed int (Roblox's i32 transform). */
export function transformI32(v) {
  return ((v << 1) ^ (v >> 31)) | 0;
}

export function untransformI32(v) {
  return ((v >>> 1) ^ -(v & 1)) | 0;
}

/** Zigzag-encode a 64-bit signed int. */
export function transformI64(v) {
  const b = BigInt(v);
  return (b << 1n) ^ (b >> 63n);
}

export function untransformI64(v) {
  const b = BigInt(v);
  return (b >> 1n) ^ -(b & 1n);
}

/** f32 bit rotation applied to every float in interleaved float arrays. */
export function rotateF32Bits(bits) {
  // rotate_left(1)
  return (((bits << 1) | (bits >>> 31)) >>> 0) >>> 0;
}

export function unrotateF32Bits(bits) {
  // rotate_right(1)
  return ((bits >>> 1) | (bits << 31)) >>> 0;
}
