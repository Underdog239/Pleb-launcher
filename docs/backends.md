# Backends

`studio-cli` has one command surface and a pluggable engine behind it. Choosing
a backend is a fidelity decision, and the tradeoff is unavoidable.

## `local`

Runs anywhere Node runs, including Linux and CI. No Roblox installation, no API
keys, no network.

**Can do**

- Read and write `.rbxm`, `.rbxl`, `.rbxmx`, `.rbxlx`.
- Walk the instance tree; inspect every property, including how it is
  serialized (canonical name vs serialized alias vs value type).
- Author models from a JSON spec and build Rojo-style projects.
- Convert between binary and XML formats.
- Produce an approximate top-down visualisation of a scene.

**Cannot do**

- Execute engine Luau. There is no engine.
- Simulate physics or run services (`Players`, `RunService`, `DataStoreService`).
- Render anything faithful. `view_scene` projects axis-aligned bounding boxes.

**Can do without a file at all**

The reflection database is complete enough to answer questions about the API
itself, so `api class`, `api enum`, `api property` and `api search` (the
`api_lookup` MCP tool) work with no model, no Studio and no network. That is the
surface an agent reaches for while writing code rather than inspecting it.

This is a *file and structure* tool. It is exact about the data model and
honest about the fact that it is not the engine.

## `studio`

Wraps a real Roblox Studio installation on Windows or macOS. Full fidelity,
because it *is* the engine.

**Mechanisms**

- Studio's documented CLI:
  - `--task RunScript --runScriptFile x.luau --outputFile out.log --quitAfterExecution`
    runs Luau at command-bar permission, optionally inside a specific place.
  - `--task EditPlace` / `EditFile` opens a place for editing.
  - `--api`, `--fullApi`, `--apiV2` dump the API surface to JSON.
- Studio's built-in MCP server (stdio), which exposes `execute_luau`,
  `search_game_tree`, `inspect_instance`, `script_read`, `multi_edit`,
  `script_grep`, asset tools, and a `playtest` subagent.

**Requirements**

- Studio installed; the binary is auto-detected, or set `ROBLOX_STUDIO_PATH`.
- For the MCP proxy, enable Studio as an MCP server in Studio's Assistant
  settings, or set `ROBLOX_STUDIO_MCP_PATH`.
- A GUI session. Studio's CLI still launches the application.

**Two ways to use it**

- `--backend studio` routes the individual commands (`exec`, `api dump`) to
  Studio directly.
- `studio proxy` (or `studio serve --proxy`) hands the *whole* MCP session to
  Studio's own server over stdio. Nothing is re-encoded and no tool list is
  mirrored, so every Studio tool — including `multi_edit`, `script_grep` and
  the playtest subagent — is available as-is. The trade is that Studio's tool
  list is Studio's; the built-in surface is not available at the same time. On
  a host without Studio this fails immediately with the reason rather than
  hanging on a pipe that will never open.

## `auto`

Default. Picks `studio` when a Studio installation is detected, then
`opencloud` when an API key is present, then `local`. Studio comes first because
it is the engine itself, with physics and a real DataModel; Open Cloud is a real
server but a constrained one. All three emit the same JSON shapes, so an agent's
perception code does not change when the backend flips.

## `opencloud`

Runs Luau on Roblox's own servers, headlessly, with the place loaded. This is
the only backend that runs the real engine on Linux and in CI, and it is the one
that closes the loop: build a place locally, check it statically locally, then
execute it against the real engine from the same shell.

```bash
export ROBLOX_CLOUD_API_KEY=...      # scope: universe.place.luau-execution-session:write

cat > check.luau <<'LUAU'
local part = Instance.new("Part")
part.Size = Vector3.new(4, 4, 4)
print("workspace children:", #workspace:GetChildren())
return { parts = #workspace:GetDescendants() }
LUAU

studio exec check.luau --backend opencloud --universe 123456 --place-id 987654
#   42
studio exec check.luau --backend opencloud --universe 123456 --place-id 987654 --json
#   {"state":"COMPLETE","backend":"opencloud","placeVersion":12,"logs":"...","results":{"parts":42},...}
```

`--place-version` pins a specific published version instead of the latest.
`--poll` and `--timeout` (seconds) tune the polling loop. `--quiet` suppresses
the progress line and the log passthrough. The script's own `print` output goes
to stderr so that stdout stays a clean JSON value for a pipeline, and it is
always included in `--json` output under `logs`, including when the script
fails — a failed run is exactly when its output matters most.

The same thing is available to an agent through the `execute_luau` MCP tool,
which takes `backend`, `universeId`, `placeId` and either `scriptFile` or
`script`.

**Can do**

- Run Luau against the real engine API: `Instance.new`, services, the DataModel,
  and every property that exists at runtime.
- Report the script's return values structurally, as JSON, up to 4 MB.
- Capture logs, up to 450 KB retained per task.
- Load the place's actual content, so a check can assert against real instances.

**Cannot do**

- Simulate physics, or step time. There is no physics engine in a task.
- Run the place's own scripts. They are deliberately not started, so a task
  measures the code it is given and nothing else.
- Persist changes. Edits to the DataModel are discarded when the task ends;
  only `SavePlaceAsync` inside the task could write anything back.
- Render. `render` is `none`.
- Run for more than 5 minutes, or a script larger than 4 MB.

**Requirements**

- An API key with the `universe.place.luau-execution-session:write` scope, from
  https://create.roblox.com/dashboard/credentials. Set `ROBLOX_CLOUD_API_KEY`
  (`RBLX_OC_API_KEY` is accepted too, since that is the name Roblox's own
  reference client uses).
- A universe and place id, and a place that has been published at least once.
- `--universe` and `--place-id`. Note that `--place` is *not* these: with the
  studio backend `--place` means "the local place file", and the CLI says so
  rather than guessing if you pass it here.

**Limits, as documented**

Five task creations per minute, 200 status reads per minute, 45 log reads per
minute, ten incomplete tasks per place. Retained: 450 KB of logs, task metadata
for 24 hours. All five endpoints are marked stable.

**Publishing the place that gets run**

`studio exec` loads whatever version is current, so the place it tests is only
yours if you put it there. `publish` does that:

```bash
studio publish out.rbxl --universe 123456 --place-id 987654
studio publish default.project.json --universe 123456 --place-id 987654   # builds first
studio publish out.rbxl --universe 123456 --place-id 987654 --version-type Saved
```

A Rojo project or a build spec is built to a temporary place file and then
published, and the JSON output says so (`builtFrom`), so nothing is quietly
deployed from something other than what you named. `--version-type Published`
saves and makes it live; `Saved` saves a version that is not the live one.

Note the version of this endpoint: it is **v1 under `/universes`**, not under
`/cloud/v2` like Luau Execution, and the place file is the raw request body
rather than a multipart form. It also needs a **different key scope** —
`universe-places` with the Write operation — which is why the missing-key
message distinguishes the two operations rather than printing one generic
sentence for both.

`deploy` is the whole loop, and pins the smoke test to the version it just
published:

```bash
studio deploy default.project.json --universe 123456 --place-id 987654 --run smoke.luau
```

Pinning matters. A deploy that publishes version 41 and then runs against
"latest" is measuring whatever version is newest at the moment the task starts,
which is not necessarily 41 if anything else published in between.

**What is verified, and what is not**

The request shapes, the polling loop, the log flattening, the publishing body
and content type, the failure paths and every error message are tested against a
stub server that speaks the same endpoints (`test/opencloud.test.mjs`,
`test/fixtures/stub-server.mjs`) — real HTTP, real headers, real status codes,
real aborts, no network.

**No live call to Roblox's Open Cloud API has ever been made from this
repository.** There is no key here and no published place to point at, so the
live path is unverified. Treat the contract above as documented-and-modelled,
not observed. If a live call does fail, every failure mode it can reach is
turned into a sentence that names the cause: see `explainStatus` in
`src/backends/opencloud/http.js`.

This is the one place where a claim in these docs could most easily be
overstated, so it is stated the other way: everything is tested except the part
that needs a Roblox account.
