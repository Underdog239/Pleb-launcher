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
- **Check Luau statically** against the real API database — unknown classes,
  services, enums and enum items, property typos, deprecated calls — with a
  line, a column and a fix for each.
- **Map the require graph** of a place and report missing modules, non-module
  targets, and cycles before anything runs.
- **Answer "what breaks if I delete this?"** from the reference graph, and
  inventory every asset a build depends on.
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
| Static analysis of Luau against the API database | no | **yes** |
| Require graph and cycle detection | no | **yes** |
| Reference graph, impact analysis, asset inventory | no | **yes** |
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

# Analysis that needs no engine
studio check game.rbxl              # every script inside, against the API
studio check src/Shared/Util.luau   # or one loose file
studio graph default.project.json   # require edges and cycles
studio refs game.rbxl --broken      # reference graph; only the bad edges
studio assets game.rbxl             # every image/sound/mesh the place uses
studio impact game.rbxl Workspace.Rig.Primary
studio doctor                       # what this host can actually do

# Change it
studio edit game.rbxl '[{"path":"ServerScriptService.Main","find":"print(","replace":"warn("}]'

# Full-fidelity execution (needs Studio)
studio exec smokeTest.luau --place game.rbxl --backend studio
studio api dump -o api.json --backend studio

# Drive the MCP surface directly
studio tools
studio call create_model '{"spec":{"className":"Part","name":"P"},"output":"p.rbxm"}'
```

### Checking Luau without running it

`studio check` analyses source against the reflection database, so every finding
is a fact about the API rather than a style opinion. It takes a model file (every
script inside is checked), a `default.project.json`, a directory, or a single
loose `.lua`/`.luau` file.

```console
$ studio check examples/analysis/default.project.json
warning [property-typo] ReplicatedStorage.Shared.Rig:7:8: Part.Sizee: no such property, did you mean Size?
error [unknown-enum-item] ReplicatedStorage.Shared.Rig:8:33: Enum.Material.Concree: no such item
  did you mean: Concrete?
error [not-creatable] ReplicatedStorage.Shared.Rig:11:30: Instance.new("Workspace"): this class cannot be created; the engine provides it
  did you mean: game:GetService("Workspace")?
  use game:GetService("Workspace") instead
warning [deprecated-global] ServerScriptService.Main:4:1: wait() is deprecated
  did you mean: task.wait?
  wait is deprecated and throttles differently
warning [deprecated-method] ServerScriptService.Main:5:6: :Remove() is deprecated
  did you mean: Destroy?
  Remove only unparents the instance and leaves connections alive
FAILED: 2 script(s), 2 error(s), 3 warning(s)
```

`examples/analysis/` is that project, committed, so the output above is
reproducible rather than illustrative. Exit status is `1` when there is an
error and `0` when there are only warnings, so it drops straight into CI.

| code | meaning |
|---|---|
| `unknown-class`, `not-creatable` | `Instance.new` with a name that is not a class, or one the engine provides |
| `unknown-service`, `not-a-service` | `game:GetService` with a name that is not a service |
| `unknown-enum`, `unknown-enum-item` | `Enum.Material.Concree` |
| `property-typo` | a property that does not exist, when a near miss does |
| `deprecated-global`, `deprecated-method` | `wait()`, `spawn()`, `part:Remove()`, with the modern call |
| `syntax-error` | an unterminated string, comment, or long bracket |

A false positive costs more than a missed bug, so the analyser only reports what
cannot be wrong:

- property typos are reported only for a local bound by a literal
  `Instance.new("...")`, and only when a near miss exists;
- computed names (`obj[expr]`, `Instance.new(cls)`, `Enum.Material[x]`) are
  skipped silently rather than guessed at;
- string and comment contents are never analysed as code;
- rebinding a global (`local Instance = ...`, a parameter named `Instance`)
  silences the checks about it for the whole file.

The tests make this explicit: a full idiomatic service script — services,
`require`, `pcall`, `task.*`, event connections, `CFrame` maths, string
interpolation — must produce **zero** diagnostics.

### The require graph

```console
$ studio graph examples/cycle/default.project.json
ReplicatedStorage.Shared.A -> ReplicatedStorage.Shared.B
ReplicatedStorage.Shared.B -> ReplicatedStorage.Shared.A
CYCLE: ReplicatedStorage.Shared.A -> ReplicatedStorage.Shared.B -> ReplicatedStorage.Shared.A
3 script(s), 2 require edge(s), 1 cycle(s)
```

Chains resolve against the real tree, so `script.Parent.Util`,
`script.Parent:FindFirstChild("Util")` and `game.ReplicatedStorage.Shared.Util`
all land on the same node. Reported: `require-not-found`, `require-not-module`,
`require-cycle` (once, pointing at the line that closes the loop), and
`dynamic-require` as a note — never an error.

### What depends on what

```console
$ studio build examples/references/default.project.json -o /tmp/rig.rbxlx
$ studio refs /tmp/rig.rbxlx --path Workspace.Rig.Primary
Workspace.Rig.Primary (Part)
  <- Workspace.Rig  (PrimaryPart)
  <- Workspace.Rig.Handle  (Value)

$ studio impact /tmp/rig.rbxlx Workspace.Rig.Primary
Workspace.Rig.Primary (Part), 0 child(ren)
  <1> Workspace.Rig
  <1> Workspace.Rig.Handle
  <2> Workspace.Chase
```

`<n>` is distance in the reference graph: two things hold the `Part` directly,
and `Chase` holds `Rig`, which holds the `Part` — so deleting it breaks `Rig`
and `Handle` first and `Chase` second. `examples/references/` is committed
(project files only — no built output checked in), so the commands above run as
shown.

354 properties in the API are Instance-typed, and `refs` follows all of them.
`assets` does the same for content: every image, sound, mesh, animation and
skybox, grouped by asset id, with external URLs listed separately.

An unset reference is deliberately **not** reported as broken. Roblox defaults
every reference to nothing, both decoders store an empty reference as `null`, and
a reference whose id does not resolve also arrives as `null` — the three are
indistinguishable after loading, so claiming any of them is broken would be a
guess. What *is* reported is a reference to an instance outside the model, or one
whose class the property cannot hold.

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
# ok    mcp tools: 21 exposed
# ok    value type coverage: 363/370 binary, 361/370 xml (370 types in use)
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

### References between instances

354 properties hold a reference to another instance — `Model.PrimaryPart`,
`ObjectValue.Value`, `Adornee`, seats, attachments, `HumanoidRootPart`. A
reference names something that may not exist yet, so it is written as a path and
resolved once the whole tree is built. Three spellings are accepted, in specs
and in project files alike:

```json
{
  "PrimaryPart": "Workspace.Rig.Primary",
  "Value": { "$ref": "Workspace.Rig.Primary" },
  "Other": { "Type": "Ref", "Value": "Workspace.Rig.Primary" }
}
```

A leading `game.` is accepted and stripped. A reference that cannot be resolved
is **reported, never written as nothing**:

```console
$ studio build examples/references/bad-reference.project.json -o /tmp/bad.rbxlx
warning: Rig.PrimaryPart points at "game.Workspace.Rig.Primry", which is not in
this build; did you mean "Workspace.Rig.Primary"?
```

It is a warning rather than an error, because the rest of the build is correct
and losing the whole output over one bad path would be worse.

The property is left unset, and that is the reason the warning exists: once
written, an unresolved reference and a deliberately unset one are byte-identical,
so no later inspection can tell them apart. The build is the last place the
difference is still knowable, and it says so there.

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
| `script_check` | yes | yes | static analysis of Luau against the API |
| `require_graph` | yes | yes | require edges, cycles, dynamic requires |
| `instance_references` | yes | yes | reference graph + broken references |
| `asset_inventory` | yes | yes | every asset a model references |
| `impact_analysis` | yes | yes | what breaks if an instance is deleted |
| `format_coverage` | yes | yes | which value types each format can carry |
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
  luau/lexer.js          Luau tokenizer with exact positions
  luau/analyze.js        static analysis against the reflection database
  luau/requires.js       require graph over the real instance tree
  rbx/graph.js           reference graph, asset inventory, impact analysis
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
npm test          # 242 tests: LZ4, binary codec, XML codec, reflection,
                  # validation, project build, CLI, MCP, script search/diff/edit,
                  # a round-trip test per value type in both codecs, the Luau
                  # lexer and analyser, the require graph, and the reference
                  # graph / asset inventory / impact analysis
```

## Verification against the reference implementation

Round-tripping through our own codec only proves self-consistency. The binary
and XML writers are therefore also meant to be verified against **rbx-dom**, the
reference implementation, via [Lune](https://lune-org.github.io/docs):

> **Status: not run in the authoring environment.** The Lune binary is fetched
> from GitHub release assets, which that sandbox cannot reach. The procedure
> below is the one to run, and the differential type probe in
> `test/formats.test.mjs` covers the same ground in-process — but no claim of a
> completed cross-implementation run is being made here.

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

