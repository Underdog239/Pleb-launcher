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

Rojo is the standard way to get a Roblox project onto a filesystem, and it is
very good at it. It is also built around a live Studio session: the plugin does
the work, and `rojo serve` streams changes into a running engine.

None of that helps an agent (or a CI job) that has a model file and no Studio.
This project covers that ground:

- **Read + write** model files, in both binary and XML formats.
- **Author** content from a JSON spec (agents can generate geometry).
- **Build** Rojo-style projects — the same project format, offline.
- **Perceive** a scene as structured JSON, or as an approximate SVG projection.
- **Search, diff and edit** scripts inside a model without extracting anything.
- **Execute** Luau with full engine fidelity through Studio when available.
- **Speak MCP**, so agents talk to it exactly like they talk to Studio's own
  built-in MCP server.
- **Fail loudly.** Every write is validated first; a bad property, a wrong type,
  or a value the target format cannot represent is rejected with a path, an
  expectation, and a suggested fix — never silently dropped.

### How it compares to Rojo

Being honest about this matters more than winning the comparison, because the
whole point of the project is that nothing fails quietly:

| | Rojo | studio-cli |
|---|---|---|
| Live two-way sync with Studio | **yes**, via its plugin | no — not attempted |
| Studio plugin, VS Code extension, Wally/Aftman | **yes** | no |
| Years of production hardening | **yes** | no |
| Works with no Studio, no plugin, no GUI | partly (`build` only) | **yes** |
| Read/modify an arbitrary `.rbxm` you were handed | no | **yes** |
| Script search, diff and edit inside a model | no | **yes** |
| Machine-readable diagnostics for every write | no | **yes** |
| MCP tool surface | no | **yes** |

It is not a Rojo replacement; it is the offline, agent-facing half. Rojo owns
the live-sync workflow, and this project deliberately consumes Rojo's ecosystem
data (the reflection and patch databases come from **rbx-dom**).

### Project format compatibility

`studio build` reads the same project files Rojo does, including the parts that
only matter for a static build:

- `$className`, `$path`, `$properties`, `$ignoreUnknownInstances`
- Nested directories, `init.lua` / `init.server.luau` / `init.client.luau`
- `.meta.json` (per-script and `init.meta.json`, including `className`)
- `.model.json`, and `.rbxm`/`.rbxmx`/`.rbxl`/`.rbxlx` files referenced by
  `$path` (a single-root model becomes the node itself, as Rojo does)
- Explicit rbx-dom property values: `{ "Type": "Vector3", "Value": [1, 2, 3] }`
- `.txt` / `.csv` as `StringValue`

**Not supported:** `Attributes` and `Tags`. They live in `AttributesSerialize`
and `Tags` columns this codec does not model, so rather than write a project
that loses them, the builder reports them by name and continues.

Anything in a project directory that maps to no instance — a stray `.xyz`, a
`.meta.json` whose owner does not exist, an `init.lua` on a `$className` that
cannot hold source — is reported as a build warning. None of it is skipped in
silence.

## Validation

This is the part that matters most for agents. Without it, a misspelled property
or a wrong value type is silently discarded and the agent ships a file that
looks fine and is wrong. `studio model`, `studio build` and the `create_model`
/ `build` MCP tools all validate **before writing**, and refuse to write on
error.

```bash
studio model tower.json -o tower.rbxm
# error: Part.Sizee is not a valid property of Part
#   did you mean: Size?
# FAILED: 1 instances, 1 error(s), 0 warning(s)

studio validate tower.rbxm                  # human-readable
studio validate tower.rbxm --json           # machine-readable diagnostics
studio model tower.json -o t.rbxm --force   # write anyway
```

Diagnostics are structured, so an agent can act on them:

```json
{
  "severity": "error",
  "code": "unknown-property",
  "message": "Part.Sizee is not a valid property of Part",
  "path": "P.Sizee",
  "actual": "Sizee",
  "suggestion": "Size"
}
```

| code | severity | meaning |
|---|---|---|
| `unknown-property` | error | property does not exist on the class, with a did-you-mean |
| `invalid-value` | error | wrong shape/type for the property's value type |
| `invalid-enum-item` | error | unknown enum item name, with a did-you-mean |
| `invalid-enum-value` | error | numeric enum value outside the domain (0 = unset, always legal) |
| `invalid-reference` | error | a `Ref` pointing at the wrong class (`PrimaryPart` must be a `BasePart`) |
| `unknown-class` | error | class not in the API dump, with a did-you-mean |
| `out-of-range` | warning | e.g. `Transparency` outside 0..1 |
| `color-out-of-range` | warning | a `Color3` channel outside 0..1 |
| `duplicate-name` | warning | two siblings with the same name |

`--strict` promotes warnings to failures.

Every problem is reported in one pass — one bad enum item does not hide the
three other mistakes in the same spec. Ranges are checked against the type you
*write*, not the type on disk: `Part.Color` is a `Color3` (0..1) in the API and a
`Color3uint8` in the file, so `"Color": [255, 0, 0]` warns instead of being
silently clamped to red.

Three failures are distinguished, because they need three different fixes:

| what you wrote | code | what to do |
|---|---|---|
| a name that does not exist (`Sizee`) | `unknown-property` | rename it — a did-you-mean is included |
| a real property the engine never saves (`RobloxLocked`) | `unserializable-property` | stop expecting it to persist |
| a type the target format cannot represent | `unsupported-type` | write a different format, or drop the property |

That last one used to be a silent drop: the binary writer omitted any property
whose value type it had no encoding for, and said nothing. Now the check happens
before the write, against the format you are actually writing, and
`studio validate <file> --format xml` will tell you what a conversion would lose.

Both writers report the same way, so a property can never leave with the file
and arrive without it:

### Searching, diffing and editing scripts

The perception surface goes past reading one script:

```bash
studio grep game.rbxl 'DataStore' -i        # one line per match, grep-style
studio grep game.rbxl 'require\(' --json    # path, line, column, text
studio diff before.rbxm after.rbxm          # what actually changed
studio edit game.rbxl '[{"path":"ServerScriptService.Main","find":"print(","replace":"warn("}]'
```

`studio edit` (and the `multi_edit` MCP tool) resolves and checks **every** edit
before applying any of them, so a typo in one path cannot leave a model
half-edited. An ambiguous `find` is refused rather than guessed at.

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
studio grep game.rbxl 'require\(' --limit 20
studio doctor

# Author content
studio model tower.json -o tower.rbxm
studio build default.project.json -o game.rbxl
studio convert tower.rbxm tower.rbxmx
studio validate tower.rbxm

# Perceive it
studio view tower.rbxm -o tower.svg
studio view tower.rbxm --format json
studio diff before.rbxm after.rbxm

# Change it
studio edit game.rbxl '[{"path":"ServerScriptService.Main","find":"print(","replace":"warn("}]'

# Full-fidelity execution (needs Studio)
studio exec smokeTest.luau --place game.rbxl --backend studio
studio api dump -o api.json --backend studio

# Drive the MCP surface directly
studio tools
studio call create_model '{"spec":{"className":"Part","name":"P"},"output":"p.rbxm"}'
```

### Options, typos and capability checks

Options take a value as `--output x` or `--output=x`. An unknown option or
command is an **error**, never a stray positional argument — silently ignoring
`--output=tower.rbxm` and writing `out.rbxm` is the same class of bug as a
silently dropped property:

```bash
studio model tower.json --ouptut=tower.rbxm
# error: unknown option: --ouptut — did you mean --output?
studio trees game.rbxl
# error: unknown command: trees — did you mean tree?
```

MCP tool names get the same treatment. `studio doctor` answers "what can this
host actually do?" before an agent discovers the limits by failing:

```bash
studio doctor
# ok    node: v22.22.3
# ok    reflection database: 935 classes, 648 enums
# ok    serialization patches: BasePart.Size -> size, BasePart.Color -> Color3uint8
# ok    mcp tools: 15 exposed
# ok    roblox studio: not installed (local backend only — no engine Luau; no MCP server)
```

```json
{ "severity": "error", "code": "unsupported-type",
  "message": "P.UniqueId has type UniqueId, which the xml writer cannot represent (no xml encoding); it would be dropped from the output",
  "path": "P.UniqueId", "actual": "UniqueId",
  "note": "the property is set but would not survive a write" }
```

### What is not representable

Of the 370 value types the API actually uses, **363 are writable to binary and
361 to XML** (`studio doctor` reports this against your reflection database, so
it cannot silently rot). The gaps, and why they are gaps:

| types | binary | xml | why |
|---|---|---|---|
| `SecurityCapabilities`, `UniqueId` | yes | **no** | rbx_xml uses a fixed-width form we have not verified; refusing beats inventing |
| `QDir`, `QFont`, `DateTime` | **no** | **no** | Studio plugin settings and capture metadata, not game content |
| `TweenInfo`, `User`, `Region3int16`, `Path2DControlPoint` | **no** | **no** | never serialized by the engine at all (`canSave = false`) |

None of these fail quietly. A property in one of these types is reported with
`unsupported-type` before a write, or `unserializable-property` if the engine
itself would never save it.

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
studio proxy                 # hand the session to Studio's own MCP server
```

Point any MCP client at it. Both newline-delimited JSON and LSP-style
`Content-Length` framing are accepted, and **replies use the framing the client
sent** — a framed client cannot parse a newline-delimited reply.

`studio proxy` (or `studio serve --proxy`) is a byte pipe to Studio's built-in
MCP server when it is available, so you keep Studio's real `execute_luau` and
playtest tools without keeping a tool list in sync. It needs Studio; the local
backend has no engine to proxy to and says so.

Tools exposed (names mirror Studio's own MCP server where they overlap):

| tool | local | studio | notes |
|---|---|---|---|
| `backend_info` | yes | yes | capabilities + availability |
| `search_game_tree` | yes | yes | hierarchy as JSON |
| `inspect_instance` | yes | yes | every property + serialization info |
| `script_read` | yes | yes | script source |
| `script_grep` | yes | yes | text/regex search across all scripts |
| `model_stats` | yes | yes | counts by class |
| `create_model` | yes | yes | JSON spec -> `.rbxm`/`.rbxmx` |
| `build` | yes | yes | Rojo-style project -> place |
| `convert` | yes | yes | binary <-> XML |
| `validate_model` | yes | yes | structured diagnostics + suggestions |
| `view_scene` | yes | yes | approximate SVG / JSON |
| `diff_models` | yes | yes | what changed between two models |
| `multi_edit` | yes | yes | edit script sources, all-or-nothing |
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
    validate.js          validation + structured diagnostics
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
npm test          # 158 tests: LZ4, binary codec, XML codec, reflection,
                  # validation, project build, CLI, MCP, script search/diff/edit,
                  # and a round-trip test per value type in both codecs
```

## Verification against the reference implementation

Round-tripping through our own codec only proves self-consistency. The binary
and XML writers are therefore also verified against **rbx-dom**, the reference
implementation, via [Lune](https://lune-org.github.io/docs):

```bash
# one-time: grab the Lune binary for your platform
gh release download v0.11.0 -R lune-org/lune -p 'lune-*-linux-x86_64.zip'

studio model examples/tower.json -o /tmp/tower.rbxm
lune run scripts/verify-with-lune.luau /tmp/tower.rbxm Tower.Shaft
#   Size = 4, 12, 4
#   CFrame = 0, 6.5, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1
#   Material = Enum.Material.Concrete
```

`test/binary-format.test.mjs` additionally pins the exact on-disk bytes
(interleaving, zigzag, float bit-rotation, serialized names, footer) against an
independent reimplementation of rbx-dom's transforms, so a self-consistent
encoding bug cannot hide behind our own decoder.

## License

MIT

