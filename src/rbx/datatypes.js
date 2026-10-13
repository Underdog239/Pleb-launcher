// Constructors and helpers for Roblox datatype values.
//
// Values are plain JS objects so they are trivially JSON-serializable for the
// agent-facing perception layer:
//   Vector3 {x,y,z} · Vector2 {x,y} · Color3 {r,g,b} (0..1)
//   CFrame {position:{x,y,z}, rotation:[r00..r22] row-major}
//   UDim {scale,offset} · UDim2 {x:{scale,offset}, y:{...}}
//   NumberSequence {keypoints:[{time,value,envelope}]}
//   ColorSequence {keypoints:[{time,color:{r,g,b}}]}
//   NumberRange {min,max} · Rect {min:{x,y}, max:{x,y}}
//   Ray {origin:{x,y,z}, direction:{x,y,z}}
//   Font {family,weight,style,cachedFaceId}
//   Content {source:'none'|'uri'|'object', value}

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const v2 = (x = 0, y = 0) => ({ x, y });
export const color3 = (r = 0, g = 0, b = 0) => ({ r, g, b });
export const udim = (scale = 0, offset = 0) => ({ scale, offset });
export const udim2 = (x = udim(), y = udim()) => ({ x, y });
export const numberRange = (min = 0, max = 0) => ({ min, max });
export const rect = (min = v2(), max = v2()) => ({ min, max });
export const ray = (origin = v3(), direction = v3()) => ({ origin, direction });

export const IDENTITY_ROTATION = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function cframe(position = v3(), rotation = IDENTITY_ROTATION) {
  return { position, rotation: [...rotation] };
}

export function numberSequence(keypoints) {
  return { keypoints };
}

export function colorSequence(keypoints) {
  return { keypoints };
}

export function font(family = 'rbxasset://fonts/families/LegacyArial.json', weight = 400, style = 0) {
  return { family, weight, style, cachedFaceId: '' };
}

// --- basic rotation IDs (rbx-dom rbx_types/src/basic_types.rs) ---------------

const ROT = {
  0x02: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  0x03: [1, 0, 0, 0, 0, -1, 0, 1, 0],
  0x05: [1, 0, 0, 0, -1, 0, 0, 0, -1],
  0x06: [1, 0, 0, 0, 0, 1, 0, -1, 0],
  0x07: [0, 1, 0, 1, 0, 0, 0, 0, -1],
  0x09: [0, 0, 1, 1, 0, 0, 0, 1, 0],
  0x0a: [0, -1, 0, 1, 0, 0, 0, 0, 1],
  0x0c: [0, 0, -1, 1, 0, 0, 0, -1, 0],
  0x0d: [0, 1, 0, 0, 0, 1, 1, 0, 0],
  0x0e: [0, 0, -1, 0, 1, 0, 1, 0, 0],
  0x10: [0, -1, 0, 0, 0, -1, 1, 0, 0],
  0x11: [0, 0, 1, 0, -1, 0, 1, 0, 0],
  0x14: [-1, 0, 0, 0, 1, 0, 0, 0, -1],
  0x15: [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  0x17: [-1, 0, 0, 0, -1, 0, 0, 0, 1],
  0x18: [-1, 0, 0, 0, 0, -1, 0, -1, 0],
  0x19: [0, 1, 0, -1, 0, 0, 0, 0, 1],
  0x1b: [0, 0, -1, -1, 0, 0, 0, 1, 0],
  0x1c: [0, -1, 0, -1, 0, 0, 0, 0, -1],
  0x1e: [0, 0, 1, -1, 0, 0, 0, -1, 0],
  0x1f: [0, 1, 0, 0, 0, -1, -1, 0, 0],
  0x20: [0, 0, 1, 0, 1, 0, -1, 0, 0],
  0x22: [0, -1, 0, 0, 0, 1, -1, 0, 0],
  0x23: [0, 0, -1, 0, -1, 0, -1, 0, 0],
};

export function rotationFromId(id) {
  return ROT[id] ? [...ROT[id]] : null;
}

/** Find a basic rotation ID for a row-major matrix, or null. */
export function rotationToId(rotation) {
  for (const [id, m] of Object.entries(ROT)) {
    if (m.every((v, i) => Math.abs(v - rotation[i]) < 1e-6)) return Number(id);
  }
  return null;
}
