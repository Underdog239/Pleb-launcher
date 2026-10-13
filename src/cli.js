// studio-cli — Roblox Studio as a command line interface for agents.

import fs from 'node:fs';
import { listBackends, resolveBackend, local, studio } from './backends/index.js';
import { loadModel, saveModel, formatFor } from './rbx/io.js';
import { viewSvg, sceneSummary } from './backends/local/view.js';
import { runStdioServer } from './mcp/server.js';
import { proxyStdio } from './mcp/proxy.js';
import { toolList, callTool } from './mcp/tools.js';
import { validateModel, formatDiagnostics, summarizeDiagnostics, closestName } from './rbx/validate.js';
import { db, serializationFor } from './rbx/reflection.js';

const VERSION = '0.1.0';

const MIN_NODE = [22, 6];

/**
 * What this host can actually do.
 *
 * An agent that has to discover a missing Studio by failing a write has already
 * wasted the turn; `studio doctor` answers the question in one call.
 */
export function checkEnvironment() {
  const checks = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  checks.push({
    name: 'node',
    ok: nodeOk,
    detail: `v${process.versions.node}${nodeOk ? '' : ` (need >=${MIN_NODE.join('.')})`}`,
  });

  try {
    const reflection = db();
    const ok = reflection.classCount > 0;
    checks.push({
      name: 'reflection database',
      ok,
      detail: `${reflection.classCount} classes, ${reflection.enumCount} enums`,
    });
  } catch (err) {
    checks.push({ name: 'reflection database', ok: false, detail: String(err?.message || err) });
  }

  try {
    // The patch database is what maps BasePart.Size -> "size"; if it is missing,
    // files serialize with the wrong property names and Studio ignores them.
    const size = serializationFor('Part').forward.get('Size');
    const color = serializationFor('Part').forward.get('Color');
    const ok = size?.serializedName === 'size' && color?.valueType === 'Color3uint8';
    checks.push({
      name: 'serialization patches',
      ok,
      detail: ok ? 'BasePart.Size -> size, BasePart.Color -> Color3uint8' : 'missing or unexpected',
    });
  } catch (err) {
    checks.push({ name: 'serialization patches', ok: false, detail: String(err?.message || err) });
  }

  try {
    checks.push({ name: 'mcp tools', ok: toolList().length > 0, detail: `${toolList().length} exposed` });
  } catch (err) {
    checks.push({ name: 'mcp tools', ok: false, detail: String(err?.message || err) });
  }

  const studioPath = studio.studioPath();
  const mcpPath = studio.mcpServerPath();
  checks.push({
    name: 'roblox studio',
    ok: true, // optional: its absence is a capability limit, not a failure
    detail: studioPath
      ? studioPath
      : `not installed (local backend only — no engine Luau; ${mcpPath ? 'MCP server found' : 'no MCP server'})`,
  });

  return checks;
}

/**
 * Every option the CLI understands. `value` options take an argument
 * (`--output x` or `--output=x`); `boolean` options are switches.
 */
export const FLAGS = {
  help: 'boolean',
  version: 'boolean',
  output: 'value',
  path: 'value',
  depth: 'value',
  format: 'value',
  plane: 'value',
  place: 'value',
  backend: 'value',
  json: 'boolean',
  spec: 'value',
  kind: 'value',
  strict: 'boolean',
  force: 'boolean',
  // script search / edit
  fixed: 'boolean',
  'ignore-case': 'boolean',
  limit: 'value',
  all: 'boolean',
  proxy: 'boolean',
};

const SHORT_FLAGS = { h: 'help', v: 'version', o: 'output', i: 'ignore-case' };

/** Long option names, for did-you-mean suggestions. */
export const flagNames = Object.keys(FLAGS).map((f) => `--${f}`);

const USAGE = `studio-cli ${VERSION} — Roblox Studio as a CLI/MCP server for agents

USAGE
  studio <command> [options]

COMMANDS
  tree <file> [--path P] [--depth N]     Instance hierarchy as JSON
  inspect <file> <path>                  All properties of one instance
  read <file> <path>                     Script source
  grep <file> <pattern> [--path P]       Search every script; -i, --fixed, --limit
  stats <file>                           Instance counts by class
  build <project.json> -o <out>          Build a Rojo-style project
  model <spec.json> -o <out>             Create a model from a JSON spec
  convert <in> <out>                     Convert binary <-> XML model files
  validate <file> [--strict]             Validate a model; non-zero exit on problems
  view <file> [-o out.svg] [--format F]  Approximate top-down visualisation
  diff <before> <after>                  Structural diff of two models
  edit <file> '[{"path":P,"find":A,"replace":B}]'   Edit script sources
  exec <script.luau> [--place F]         Run Luau in Studio (studio backend)
  api dump [-o out.json]                 Dump Studio's API surface
  backends                               List backends and capabilities
  doctor                                 Report what this host can actually do
  tools                                  List MCP tools
  call <tool> [json]                     Invoke an MCP tool directly
  serve [--proxy]                        Run the MCP server on stdio
  proxy                                  Bridge stdio to Studio's own MCP server

GLOBAL OPTIONS
  --backend <auto|local|studio>   Which engine to use (default: auto)
  --strict                        Treat warnings as failures
  --force                         Write even when validation fails
  --json                          Machine-readable output only
  -h, --help                      Show this help
  -v, --version                   Show version

Options take a value as '--output x' or '--output=x'; an unknown option is an
error, never a positional argument.

Model files: .rbxm .rbxl (binary) and .rbxmx .rbxlx (XML).
`;

/**
 * Parse argv.
 *
 * Unknown flags are an error, not a positional argument. Swallowing them is how
 * `studio model spec.json --output=tower.rbxm` (a form agents emit constantly)
 * used to write `out.rbxm` while reporting success.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let onlyPositional = false;

  // Records the flag; reports back whether the caller still has to supply a
  // value from the next argv token (`--output x` / `-o x`).
  const setFlag = (name, raw) => {
    const kind = FLAGS[name];
    if (kind === undefined) {
      const suggestion = closestName(`--${name}`, flagNames);
      throw new Error(`unknown option: --${name}${suggestion ? ` — did you mean ${suggestion}?` : ''}`);
    }
    if (kind === 'value') {
      if (raw === undefined) return true; // value comes from the next token
      flags[name] = raw;
      return false;
    }
    flags[name] = true;
    return false;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (onlyPositional) {
      positional.push(a);
      continue;
    }
    if (a === '--') {
      onlyPositional = true;
      continue;
    }
    const takeValue = (name, label) => {
      if (i + 1 >= argv.length) throw new Error(`option ${label} needs a value`);
      flags[name] = argv[++i];
    };

    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const raw = eq === -1 ? undefined : a.slice(eq + 1);
      if (setFlag(name, raw)) takeValue(name, `--${name}`);
    } else if (a.startsWith('-') && a.length > 1) {
      const short = a.slice(1);
      const name = SHORT_FLAGS[short];
      if (!name) {
        const suggestion = closestName(`--${short}`, flagNames);
        throw new Error(`unknown option: -${short}${suggestion ? ` — did you mean ${suggestion}?` : ''}`);
      }
      if (setFlag(name, undefined)) takeValue(name, `-${short}`);
    } else {
      positional.push(a);
    }
  }

  for (const numeric of ['depth', 'limit']) {
    if (typeof flags[numeric] === 'string') {
      const value = Number(flags[numeric]);
      if (!Number.isFinite(value)) throw new Error(`option --${numeric} expects a number`);
      flags[numeric] = value;
    }
  }
  return { positional, flags };
}

function out(value, flags) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  process.stdout.write(`${text}\n`);
}

function fail(message) {
  // Validation diagnostics already carry their own severity prefixes.
  const text = /^(error|warning):/.test(message) ? message : `error: ${message}`;
  process.stderr.write(`${text}\n`);
  process.exitCode = 1;
}

const COMMANDS = [
  'tree', 'inspect', 'read', 'grep', 'stats', 'build', 'model', 'convert',
  'validate', 'view', 'diff', 'edit', 'exec', 'api', 'backends', 'tools',
  'call', 'serve', 'proxy', 'doctor',
];

export async function run(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    // A typo'd option is a user error, not a crash: report it like any other.
    fail(err?.message || String(err));
    return undefined;
  }
  const { positional, flags } = parsed;
  const [command, ...rest] = positional;

  if (flags.version) return out(VERSION, flags);
  if (!command || flags.help) return out(USAGE, flags);

  const backend = resolveBackend(flags.backend || 'auto');

  try {
    switch (command) {
      case 'backends':
        return out(listBackends(), flags);

      case 'tools':
        return out(toolList(), flags);

      case 'call': {
        const [toolName, jsonArg] = rest;
        if (!toolName) throw new Error('call requires a tool name');
        const args = jsonArg ? JSON.parse(jsonArg) : {};
        return out(await callTool(toolName, args, { backend: flags.backend || 'auto' }), flags);
      }

      case 'serve': {
        // `--proxy` hands the whole protocol to Studio's own MCP server instead
        // of serving the built-in tool surface.
        if (flags.proxy) {
          if (backend.name !== 'studio') {
            throw new Error(
              'serve --proxy needs the studio backend (it forwards to Studio\'s MCP server). ' +
                'Drop --proxy to serve the built-in tools locally.',
            );
          }
          const result = await proxyStdio(studio.spawnMcpProxy());
          if (result.error) throw new Error(`Studio MCP proxy failed: ${result.error}`);
          return undefined;
        }
        runStdioServer({ backend: flags.backend || 'auto' });
        return undefined;
      }

      case 'tree': {
        const roots = loadModel(rest[0]);
        return out(local.tree(roots, { path: flags.path || '', depth: flags.depth ?? null }), flags);
      }

      case 'inspect':
        return out(local.inspect(loadModel(rest[0]), rest[1]), flags);

      case 'read':
        return out(local.readScript(loadModel(rest[0]), rest[1]), flags);

      case 'grep': {
        const [file, pattern] = rest;
        if (!file || pattern === undefined) {
          throw new Error('usage: studio grep <file> <pattern> [--path P] [--fixed] [-i] [--limit N]');
        }
        const result = local.scriptGrep(loadModel(file), pattern, {
          fixed: !!flags.fixed,
          ignoreCase: !!flags['ignore-case'],
          path: flags.path,
          limit: flags.limit,
        });
        // grep(1) semantics: no match is exit 1, so `studio grep ... || fail` works.
        if (result.matchCount === 0) process.exitCode = 1;
        if (flags.json) return out(result, flags);
        // Human-readable by default: an agent pipes --json, a person reads this.
        const lines = result.matches.map((m) => `${m.path}:${m.line}:${m.column}: ${m.text}`);
        lines.push(
          `${result.matchCount} match(es) in ${result.files.length}/${result.scriptCount} script(s)`,
        );
        return out(lines.join('\n'), flags);
      }

      case 'stats':
        return out(local.stats(loadModel(rest[0])), flags);

      case 'build': {
        const { roots, projectName } = local.buildFromProject(rest[0]);
        const target = flags.output || 'out.rbxl';
        const validation = validateModel(roots, { strict: flags.strict });
        if (!validation.ok && !flags.force) {
          process.stderr.write(`${formatDiagnostics(validation)}\n`);
          process.exitCode = 1;
          return out(validation, flags);
        }
        const bytes = saveModel(target, roots);
        return out(
          { output: target, bytes, projectName, stats: local.stats(roots), validation },
          flags,
        );
      }

      case 'model': {
        const spec = JSON.parse(fs.readFileSync(flags.spec || rest[0], 'utf8'));
        const target = flags.output || 'out.rbxm';
        const roots = local.modelFromSpec(spec);
        const validation = validateModel(roots, { strict: flags.strict });
        if (!validation.ok && !flags.force) {
          process.stderr.write(`${formatDiagnostics(validation)}\n`);
          process.exitCode = 1;
          return out(validation, flags);
        }
        const bytes = saveModel(target, roots);
        return out(
          { output: target, bytes, roots: roots.map((r) => r.getFullName()), validation },
          flags,
        );
      }

      case 'convert': {
        const roots = loadModel(rest[0]);
        const bytes = saveModel(rest[1], roots);
        return out(
          {
            input: rest[0],
            inputFormat: formatFor(rest[0]),
            output: rest[1],
            outputFormat: formatFor(rest[1]),
            bytes,
          },
          flags,
        );
      }

      case 'validate': {
        const roots = loadModel(rest[0]);
        const validation = validateModel(roots, { strict: flags.strict });
        if (!validation.ok) process.exitCode = 1;
        if (flags.json) return out(validation, flags);
        return out(formatDiagnostics(validation), flags);
      }

      case 'view': {
        const roots = loadModel(rest[0]);
        if (flags.format === 'json') return out(sceneSummary(roots), flags);
        const svg = viewSvg(roots, { plane: flags.plane || 'xz' });
        if (flags.output) {
          fs.writeFileSync(flags.output, svg);
          return out({ output: flags.output, bytes: svg.length }, flags);
        }
        return out(svg, flags);
      }

      case 'exec': {
        if (backend.name !== 'studio') {
          throw new Error(
            'exec needs the studio backend (Studio --task RunScript). This host has no Studio; ' +
              'on Linux use Open Cloud Luau Execution, or inspect/build the model locally.',
          );
        }
        const result = await studio.runScript({
          scriptFile: rest[0],
          localPlaceFile: flags.place,
          outputFile: flags.output,
        });
        return out(result, flags);
      }

      case 'api': {
        if (rest[0] !== 'dump') throw new Error('usage: studio api dump [-o out.json]');
        if (backend.name !== 'studio') {
          throw new Error('api dump needs the studio backend (Studio --api/--fullApi/--apiV2).');
        }
        return out(studio.apiDump({ outputFile: flags.output, kind: flags.kind || 'full' }), flags);
      }

      case 'diff': {
        const [before, after] = rest;
        if (!before || !after) throw new Error('usage: studio diff <before.rbxm> <after.rbxm>');
        const result = local.diffModels(loadModel(before), loadModel(after));
        if (flags.json) return out(result, flags);
        const lines = [];
        for (const a of result.added) lines.push(`+ ${a.path} (${a.className})`);
        for (const r of result.removed) lines.push(`- ${r.path} (${r.className})`);
        for (const c of result.changed) {
          lines.push(`~ ${c.path}`);
          for (const change of c.changes) {
            if (change.kind === 'property') {
              lines.push(
                `    ${change.property}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`,
              );
            } else {
              lines.push(`    ${change.kind}: ${change.from} -> ${change.to}`);
            }
          }
        }
        lines.push(
          `${result.summary.added} added, ${result.summary.removed} removed, ` +
            `${result.summary.changed} changed, ${result.summary.unchanged} unchanged`,
        );
        return out(lines.join('\n'), flags);
      }

      case 'edit': {
        const [file, editsJson] = rest;
        if (!file || !editsJson) {
          throw new Error(
            'usage: studio edit <file> \'[{"path":"ServerScriptService.Main","find":"print(","replace":"warn("}]\'',
          );
        }
        const roots = loadModel(file);
        const edits = JSON.parse(editsJson);
        const result = local.applyScriptEdits(roots, edits, { force: !!flags.force });
        if (!result.ok && !flags.force) {
          const summary = summarizeDiagnostics(result.diagnostics);
          process.stderr.write(`${formatDiagnostics(summary)}\n`);
          process.exitCode = 1;
          return out(summary, flags);
        }
        const output = flags.output || file;
        const validation = validateModel(roots);
        if (!validation.ok && !flags.force) {
          process.stderr.write(`${formatDiagnostics(validation)}\n`);
          process.exitCode = 1;
          return out(validation, flags);
        }
        const bytes = saveModel(output, roots);
        return out(
          {
            output,
            bytes,
            edits: result.files,
            // With --force the invalid edits are skipped, never silently: say so.
            skipped: result.diagnostics,
            validation,
          },
          flags,
        );
      }

      case 'proxy': {
        if (backend.name !== 'studio') {
          throw new Error(
            'proxy needs the studio backend: it bridges stdio to Studio\'s own MCP server. ' +
              'Enable Studio as an MCP server, or use the built-in tools with `studio serve`.',
          );
        }
        const result = await proxyStdio(studio.spawnMcpProxy());
        if (result.error) throw new Error(`Studio MCP proxy failed: ${result.error}`);
        return undefined;
      }

      case 'doctor': {
        // One command an agent can run to find out what this host can actually
        // do, instead of discovering limits by failing.
        const checks = checkEnvironment();
        if (flags.json) return out(checks, flags);
        const lines = checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
        lines.push(checks.every((c) => c.ok) ? 'all checks passed' : 'some checks failed');
        return out(lines.join('\n'), flags);
      }

      default: {
        const suggestion = closestName(command, COMMANDS);
        throw new Error(
          `unknown command: ${command}${suggestion ? ` — did you mean ${suggestion}?` : ''}\n\n${USAGE}`,
        );
      }
    }
  } catch (err) {
    fail(err?.message || String(err));
    return undefined;
  }
}
