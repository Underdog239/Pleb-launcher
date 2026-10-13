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

Default. Picks `studio` when a Studio installation is detected, otherwise
`local`. Because the two backends emit the same JSON shapes, an agent's
perception code does not change when the backend flips.

## A third backend: Open Cloud

The genuinely headless, high-fidelity path is Roblox's **Open Cloud Luau
Execution** API. You upload a built place, spawn an execution session task, run
a Luau entrypoint on Roblox's real servers, then poll for status and fetch logs.
`roblox/rocale-cli` wraps exactly this (`build -> upload -> run -> logs`).

It belongs as a third backend because it is the only option that is:

- headless,
- Linux-friendly,
- running the real engine,
- and still unable to render pixels.

Its costs are an API key, a published universe, and quotas — which is why it is
not the default.
