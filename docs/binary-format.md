# Roblox binary model format (rbxm / rbxl)

Reverse-engineered spec used by `src/rbx/binary.js`. Verified against
[rbx-dom](https://github.com/rojo-rbx/rbx-dom) (`rbx_binary`).

## File header

| bytes | field |
|---|---|
| 8 | magic `<roblox!` |
| 6 | signature `89 ff 0d 0a 1a 0a` |
| 2 | version (u16 LE) = 0 |
| 4 | class count (u32 LE) |
| 4 | instance count (u32 LE) |
| 8 | reserved (zero) |

## Chunks

Each chunk:

| bytes | field |
|---|---|
| 4 | name (`INST`, `PROP`, `PRNT`, `SSTR`, `META`, `END\0`) |
| 4 | compressed length (u32 LE) |
| 4 | uncompressed length (u32 LE) |
| 4 | reserved (zero) |
| * | payload |

If `compressed length == 0` the payload is raw. Otherwise it is LZ4 **block**
compressed (ZSTD if it starts with `28 b5 2f fd`). Roblox writes LZ4.

Chunks appear in order: `INST` (one per class), `PROP`, `PRNT`, `SSTR`
(optional), then `END\0` whose payload is the footer `</roblox>`.

## INST

`u32 typeId`, `string className`, `u8 isService`, `u32 instanceCount`,
referent array, then `instanceCount` bytes of `1` when `isService`.

## PROP

One chunk per (class, property): `u32 typeId`, `string propertyName`,
`u8 propertyType`, then the values for every instance of that class **in
referent order**. `Name` is always written as a `String` property.

## PRNT

`u8 version=0`, `u32 count`, referent array of instance ids, referent array of
parent ids (`-1` = no parent).

## Interleaved arrays

Numeric arrays are transposed: byte `b` of value `i` lives at
`buffer[i + b * count]`, and each value is big-endian.

| kind | transform |
|---|---|
| `u32` | none |
| `i32` | zigzag `(v << 1) ^ (v >> 31)` |
| `f32` | bit-rotate-left by 1 |
| `i64` | zigzag 64-bit |
| referent | delta-encoded, then `i32` |

## Property types

`0x01` String · `0x02` Bool · `0x03` Int32 · `0x04` Float32 · `0x05` Float64 ·
`0x06` UDim · `0x07` UDim2 · `0x08` Ray · `0x09` Faces · `0x0a` Axes ·
`0x0b` BrickColor · `0x0c` Color3 · `0x0d` Vector2 · `0x0e` Vector3 ·
`0x10` CFrame · `0x12` Enum · `0x13` Ref · `0x14` Vector3int16 ·
`0x15` NumberSequence · `0x16` ColorSequence · `0x17` NumberRange ·
`0x18` Rect · `0x19` PhysicalProperties · `0x1a` Color3uint8 ·
`0x1b` Int64 · `0x1c` SharedString · `0x1e` OptionalCFrame ·
`0x1f` UniqueId · `0x20` Font · `0x21` SecurityCapabilities · `0x22` Content

### CFrame

Per value: one byte. `0x00` means "full matrix follows" (9 LE f32, row-major
`R00..R22`). Otherwise it is a basic rotation ID (`0x02`..`0x23`, 24 of the 36
slots are valid). Positions follow as three interleaved f32 arrays.

### Enum

Values are the enum item's **numeric value**, interleaved `u32`.

### Ref

Referent array; `-1` for null.

### Content

Interleaved `i32` source types (0 none, 1 uri, 2 object), then `u32` uri count +
strings, `u32` object count + referent array, `u32` external count (0).
