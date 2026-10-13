# studio-cli

**Roblox Studio, as a CLI and MCP server, for agents.**

`studio-cli` turns Roblox Studio's capabilities into a command surface that an
AI agent (or a shell script, or CI) can drive without a human clicking in a GUI.
It reads and writes real `.rbxm`/`.rbxl`/`.rbxmx`/`.rbxlx` files, walks the
instance tree, builds Rojo-style projects, renders an approximate view of a
scene, and exposes everything over the Model Context Protocol.

It has **one command surface and two pluggable backends**:

| backend | fidelity | needs Studio | runs on |
|---|---|---|---|
| `local` | approximate — file I/O, tree, build, view | no | any OS, incl. Linux/CI |
| `studio` | full — real engine, real physics, real Luau | yes (Win/macOS) | Windows / macOS |

`--backend auto` (the default) prefers Studio when it is installed and falls
back to `local` otherwise.

## Why

Rojo is a one-way, declarative mapper: filesystem → DataModel. It does not
execute anything, does not read state back, and cannot author models
programmatically. This project fills the rest of the gap:

- **Read + write** model files, in both binary and XML formats.
- **Author** content from a JSON spec (agents can generate geometry).
- **Build** Rojo-style projects.
- **Perceive** a scene as structured JSON, or as an approximate SVG projection.
- **Execute** Luau with full engine fidelity through Studio when available.
- **Speak MCP**, so agents talk to it exactly like they talk to Studio's own
  built-in MCP server.

## Install

Requires Node.js 22.6+ (native ESM, runs directly from source). There are **no
runtime dependencies**.

```bash
git clone <this repo> studio-cli
cd studio-cli
node bin/studio.js --help
npm link          # optional: then just `studio --help`
```

## CLI

```bash
# Inspect a model
studio tree game.rbxl --depth 2
studio inspect game.rbxl Workspace.SpawnLocation
studio stats game.rbxl
studio read game.rbxl ServerScriptService.Main

# Author content
studio model tower.json -o tower.rbxm
studio build default.project.json -o game.rbxl
studio convert tower.rbxm tower.rbxmx

# Perceive it
studio view tower.rbxm -o tower.svg
studio view tower.rbxm --format json

# Full-fidelity execution (needs Studio)
studio exec smokeTest.luau --place game.rbxl --backend studio
studio api dump -o api.json --backend studio

# Drive the MCP surface directly
studio tools
studio call create_model '{"spec":{"className":"Part","name":"P"},"output":"p.rbxm"}'
```

### Authoring spec

`studio model` takes a JSON description of an instance tree. Values are coerced
to the property's real type using the reflection database, so enums accept their
item names and vectors accept arrays:

```json
{
  "className": "Model",
  "name": "Tower",
  "children": [
    {
      "className": "Part",
      "name": "Base",
      "properties": {
        "Size": [8, 1, 8],
        "CFrame": [0, 0, 0],
        "Color": [0.6, 0.2, 0.2],
        "Material": "Concrete",
        "Anchored": true
      }
    }
  ]
}
```

### Project format

`studio build` accepts the standard Rojo `default.project.json` shape
(`$className`, `$path`, `$properties`), mapping `.lua`/`.luau` files to
`ModuleScript`, `.server.luau` to `Script`, `.client.luau` to `LocalScript`, and
`init.*` to the containing instance's source.

## MCP server

```bash
studio serve                 # JSON-RPC 2.0 over stdio
studio serve --backend local
```

Point any MCP client at it. Both newline-delimited JSON and LSP-style
`Content-Length` framing are accepted.

Tools exposed (names mirror Studio's own MCP server where they overlap):

| tool | local | studio | notes |
|---|---|---|---|
| `backend_info` | yes | yes | capabilities + availability |
| `search_game_tree` | yes | yes | hierarchy as JSON |
| `inspect_instance` | yes | yes | every property + serialization info |
| `script_read` | yes | yes | script source |
| `model_stats` | yes | yes | counts by class |
| `create_model` | yes | yes | JSON spec -> `.rbxm`/`.rbxmx` |
| `build` | yes | yes | Rojo-style project -> place |
| `convert` | yes | yes | binary <-> XML |
| `view_scene` | yes | yes | approximate SVG / JSON |
| `execute_luau` | no | yes | real engine, command-bar permission |
| `api_dump` | no | yes | Studio's API surface |

## Architecture

```
src/
  cli.js                 command surface
  mcp/server.js          MCP stdio server (JSON-RPC 2.0)
  mcp/tools.js           tool definitions + dispatch
  backends/index.js      backend registry ("auto" resolution)
  backends/local/        file I/O, tree, build, view  (no Roblox needed)
  backends/studio/       Studio CLI flags + MCP proxy (real engine)
  rbx/
    binary.js            rbxm/rbxl binary codec
    xml.js               rbxmx/rbxlx XML codec
    reflection.js        class/property/enum database + serialization mapping
    instance.js          in-memory instance tree
    datatypes.js         Vector3/CFrame/Color3/... + rotation IDs
    io.js                format dispatch by extension
  util/
    lz4.js               LZ4 block codec (used by the binary format)
    xml.js               minimal XML parser/serializer
    bin.js               little-endian binary primitives
```

### Where the data comes from

Nothing about the engine's data model is guessed:

- **`src/rbx/reflection.json`** is generated from Roblox's official API dump
  (`scripts/gen-reflection.mjs`) — 935 classes, 648 enums, and per-property
  serialization flags.
- **`src/rbx/patches.json`** is generated from rbx-dom's patch database
  (`scripts/gen-patches.mjs`) — the serialization aliases the API dump does not
  describe, e.g. `BasePart.Size` -> `size` and `BasePart.Color` -> `Color3uint8`.
- The binary format is implemented against `docs/binary-format.md`, derived from
  rbx-dom's `rbx_binary` source.

Regenerate both:

```bash
node scripts/gen-reflection.mjs     # needs network (or a local API-Dump.json)
node scripts/gen-patches.mjs        # needs network
```

## Honest limitations

- **There is no headless Roblox.** The engine is closed source, there is no
  Linux build of Studio, and Studio has no headless mode. Anything claiming
  otherwise is wrong.
- The `local` backend **cannot execute engine Luau or run physics**. It is a
  file/tree/authoring tool with an approximate renderer, not an engine.
- `view_scene` is a top-down **axis-aligned projection** — good for layout and
  footprint, not for appearance.
- The `studio` backend requires Studio and therefore Windows/macOS. Studio's
  documented CLI flags (`--task RunScript`, `--api`, ...) are stable; any
  undocumented flag is explicitly subject to change.
- For headless execution on Linux, the correct path is Roblox's **Open Cloud
  Luau Execution** API (see `roblox/rocale-cli`), which runs a built place on
  Roblox's real servers and returns logs. Wiring that in as a third backend is
  the natural next step.

## Tests

```bash
npm test          # 26 tests: LZ4, binary codec, XML codec, reflection, CLI, MCP
```

## License

MIT

