// studio-cli — Roblox Studio as a command line interface for agents.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listBackends, resolveBackend, local, studio, opencloud } from './backends/index.js';
import { loadModel, saveModel, formatFor } from './rbx/io.js';
import { viewSvg, sceneSummary } from './backends/local/view.js';
import { runStdioServer } from './mcp/server.js';
import { proxyStdio } from './mcp/proxy.js';
import { toolList, callTool } from './mcp/tools.js';
import {
  validateModel,
  formatDiagnostics,
  summarizeDiagnostics,
  closestName,
  coverageReport,
} from './rbx/validate.js';
import { db, serializationFor } from './rbx/reflection.js';
import { analyzeSource, summarizeScripts } from './luau/analyze.js';
import { deobfuscate, detectObfuscation, DeobfuscationError } from './luau/deobfuscate.js';
import { parse as parseLuau } from './luau/parse.js';
import { buildRequireGraph, checkTreeBindings, scriptsInModel } from './luau/requires.js';
import { referenceGraph, contentInventory, impactAnalysis, indexByPath } from './rbx/graph.js';
import { sourceMapFromProject, sourceMapFromModel, countNodes } from './rbx/sourcemap.js';
import { describeClass, describeEnum, classesWithProperty, searchApi, apiDataInfo } from './rbx/api.js';

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

  try {
    const info = apiDataInfo();
    checks.push({
      name: 'api data',
      ok: true,
      detail:
        `${info.classCount} classes, ${info.enumCount} enums, ${info.enumItemCount} enum items` +
        (info.hasAccessFlags ? `, ${info.annotatedProperties} properties with access flags` : ' (no access flags — regenerate)'),
    });
  } catch (err) {
    checks.push({ name: 'api data', ok: false, detail: String(err?.message || err) });
  }

  try {
    // Coverage of the value types the API actually uses, so a caller knows what
    // a build can and cannot carry before it loses something.
    const coverage = coverageReport();
    checks.push({
      name: 'value type coverage',
      ok: true,
      detail:
        `${coverage.binary.covered}/${coverage.totalTypes} binary, ` +
        `${coverage.xml.covered}/${coverage.totalTypes} xml (${coverage.totalTypes} types in use)`,
    });
  } catch (err) {
    checks.push({ name: 'value type coverage', ok: false, detail: String(err?.message || err) });
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
  checks.push({
    name: 'open cloud',
    ok: true, // optional: no key is a capability limit, not a broken install
    detail: opencloud.available()
      ? 'api key found: headless engine Luau is available (studio exec --backend opencloud)'
      : 'no api key: headless engine Luau unavailable (set ROBLOX_CLOUD_API_KEY to enable)',
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
  // reference graph
  broken: 'boolean',
  // open cloud execution. `--place` already means "the place file" for the
  // studio backend, and `--version` already prints this tool's own version, so
  // the ids and the place version get unambiguous names of their own.
  universe: 'value',
  'place-id': 'value',
  'place-version': 'value',
  poll: 'value',
  timeout: 'value',
  quiet: 'boolean',
  'version-type': 'value',
  run: 'value',
  'include-non-scripts': 'boolean',
  // deobfuscation
  report: 'boolean',
  detect: 'boolean',
  rename: 'boolean',
  'rename-all': 'boolean',
  fold: 'boolean',
  simplify: 'boolean',
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
  check <model | project.json | .luau>   Static analysis of Luau against the API
  graph <model | project.json>           Require graph: edges and cycles
  refs <model file> [--path P]           Instance references; --broken lists bad ones
  assets <model file> [--kind K]         Every asset the model references
  impact <model file> <path>             What depends on an instance, transitively
  view <file> [-o out.svg] [--format F]  Approximate top-down visualisation
  diff <before> <after>                  Structural diff of two models
  edit <file> '[{"path":P,"find":A,"replace":B}]'   Edit script sources
  exec <script.luau> [--place F]         Run Luau in Studio (studio backend)
  exec <script.luau> --backend opencloud Run Luau on Roblox's servers, headless
         --universe N --place-id N [--place-version N] [--poll S] [--timeout S]
  publish <file|project.json>            Publish a place through Open Cloud
         --universe N --place-id N [--version-type Published|Saved]
  deploy <project.json|spec.json>        Build, publish, and optionally smoke-test
         --universe N --place-id N [--run smoke.luau]
  sourcemap <project|place> [-o F]       sourcemap.json for Luau tooling
  deobfuscate <file> [-o out]            Fold constants, run decode loops, cut
                                         dead code, rename
         [--report] [--detect] [--rename-all] [--no-fold] [--no-simplify]
  api dump [-o out.json]                 Dump Studio's API surface (needs Studio)
  api class <ClassName>                  Properties, types, and what is saved
  api enum <EnumName>                    Items and their numeric values
  api property <Name>                    Which classes can hold this property
  api search <term>                      Search classes, enums and enum items
  backends                               List backends and capabilities
  doctor                                 Report what this host can actually do
  tools                                  List MCP tools
  call <tool> [json]                     Invoke an MCP tool directly
  serve [--proxy]                        Run the MCP server on stdio
  proxy                                  Bridge stdio to Studio's own MCP server

GLOBAL OPTIONS
  --backend <auto|local|studio|opencloud>   Which engine to use (default: auto)
  --strict                        Treat warnings as failures
  --force                         Write even when validation fails
  --json                          Machine-readable output only
  -h, --help                      Show this help
  -v, --version                   Show version

Options take a value as '--output x' or '--output=x'; an unknown option is an
error, never a positional argument.

"auto" picks the highest fidelity this host can reach: Studio when it is
installed, then Open Cloud when ROBLOX_CLOUD_API_KEY is set, then local.

Model files: .rbxm .rbxl (binary) and .rbxmx .rbxlx (XML).
`;

/**
 * Parse argv.
 *
 * Unknown flags are an error, not a positional argument. Swallowing them is how
 * `studio model spec.json --output=tower.rbxm` (a form agents emit constantly)
 * used to write `out.rbxm` while reporting success.
 */
/**
 * Get a publishable place file out of whatever the user pointed at.
 *
 * `.rbxl`/`.rbxlx` is published as it stands. A Rojo project or a build spec is
 * built first, into a temporary file, and the caller is told that happened so
 * nothing is published silently.
 */
function preparePlaceFile(source, flags) {
  const ext = path.extname(String(source)).toLowerCase();
  if (ext === '.rbxl' || ext === '.rbxlx') return { placeFile: source, built: false };

  let roots;
  if (ext === '.json') {
    const spec = JSON.parse(fs.readFileSync(source, 'utf8'));
    // A Rojo project has a tree; a build spec has a class. Both are accepted
    // here because both are what someone has in front of them before a deploy.
    if (spec.className || spec.class) roots = local.modelFromSpec(spec);
    else roots = local.buildFromProject(source).roots;
  } else {
    throw new Error(
      `cannot publish ${source}: expected a .rbxl or .rbxlx place file, or a .json project/spec`,
    );
  }
  void flags;

  const target = path.join(os.tmpdir(), `studio-publish-${process.pid}-${Date.now()}.rbxl`);
  const bytes = saveModel(target, roots);
  return { placeFile: target, built: true, builtBytes: bytes };
}

/** How many nodes in a sourcemap are scripts. */
function countScripts(node) {
  let total = node.className && SCRIPT_CLASSES.has(node.className) ? 1 : 0;
  for (const child of node.children || []) total += countScripts(child);
  return total;
}

// The three classes that hold source, plus the engine's internal ones.
const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript', 'CoreScript']);

/** `versions/3` -> 3; a bare number stays a number. */
function parseVersion(value) {
  if (value === null || value === undefined) return null;
  const m = /(\d+)\s*$/.exec(String(value));
  return m ? Number(m[1]) : null;
}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let onlyPositional = false;

  // Records the flag; reports back whether the caller still has to supply a
  // value from the next argv token (`--output x` / `-o x`).
  const setFlag = (name, raw) => {
    let key = name;
    // `--no-<flag>` turns a boolean off. Writing it once here means every
    // boolean flag gets a negation, rather than each command inventing its own.
    if (FLAGS[key] === undefined && key.startsWith('no-') && FLAGS[key.slice(3)] === 'boolean') {
      flags[key.slice(3)] = false;
      return false;
    }
    const kind = FLAGS[key];
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
  'validate', 'view', 'check', 'graph', 'refs', 'assets', 'impact', 'diff',
  'edit', 'exec', 'api',
  'backends', 'tools', 'call', 'serve', 'proxy', 'doctor',
];

/** Report a name that does not exist, with the closest real one, and exit 1. */
function notFoundWith(term, suggestions, flags) {
  process.exitCode = 1;
  const lines = [`no such name: ${term}`];
  if (suggestions && suggestions.length > 0) lines.push(`  did you mean: ${suggestions.join(', ')}?`);
  return out(lines.join('\n'), flags);
}

/** Extensions treated as a bare Luau source file rather than a model. */
const LUAU_EXTS = new Set(['.lua', '.luau']);

/**
 * Load whatever the user pointed at. A `.project.json` is built into a tree
 * first, so `check` and `graph` work on the project an agent is actually
 * editing, not just on an already-built file.
 */
export function loadTarget(target) {
  if (LOOKS_LIKE_PROJECT(target)) {
    return local.buildFromProject(target).roots;
  }
  return loadModel(target);
}

function LOOKS_LIKE_PROJECT(target) {
  return /\.project\.json$/i.test(target) || /(^|[\\/])default\.json$/i.test(target);
}

/** Render script diagnostics the way the model validator renders its own. */
export function formatScriptDiagnostics(result) {
  if (result.diagnostics.length === 0) {
    return `ok: ${result.scriptCount} script(s), no problems`;
  }
  const lines = result.diagnostics.map((d) => {
    const tag = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'note';
    // The code is included in the text form too: it is the one token an agent
    // (or a grep) can key on without parsing prose.
    const code = d.code ? ` [${d.code}]` : '';
    const where = d.line ? `${d.file}:${d.line}:${d.col ?? 1}: ` : d.file ? `${d.file}: ` : '';
    let line = `${tag}${code} ${where}${d.message}`;
    // Several messages already spell the fix out; don't say it twice.
    if (d.suggestion && !String(d.message).includes(d.suggestion)) {
      line += `\n  did you mean: ${d.suggestion}?`;
    }
    if (d.hint) line += `\n  ${d.hint}`;
    return line;
  });
  lines.push(
    `${result.ok ? 'ok' : 'FAILED'}: ${result.scriptCount} script(s), ` +
      `${result.errorCount} error(s), ${result.warningCount} warning(s)`,
  );
  return lines.join('\n');
}

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
        const { roots, projectName, warnings } = local.buildFromProject(rest[0]);
        const target = flags.output || 'out.rbxl';
        const validation = validateModel(roots, { strict: flags.strict, format: formatFor(target) });
        if (!validation.ok && !flags.force) {
          process.stderr.write(`${formatDiagnostics(validation)}\n`);
          process.exitCode = 1;
          return out(validation, flags);
        }
        const bytes = saveModel(target, roots);
        // Files the project references but that map to no instance are reported,
        // never silently omitted from the place.
        for (const w of warnings || []) process.stderr.write(`warning: ${w.message}\n`);
        return out(
          {
            output: target,
            bytes,
            projectName,
            stats: local.stats(roots),
            validation,
            ...(warnings && warnings.length ? { projectWarnings: warnings } : {}),
          },
          flags,
        );
      }

      case 'model': {
        const spec = JSON.parse(fs.readFileSync(flags.spec || rest[0], 'utf8'));
        const target = flags.output || 'out.rbxm';
        const roots = local.modelFromSpec(spec);
        // Validate against the format we are about to write, so a property the
        // target codec cannot represent fails here rather than vanishing.
        const validation = validateModel(roots, { strict: flags.strict, format: formatFor(target) });
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
        const target = formatFor(rest[1]);
        // A conversion is exactly where a format gap bites: the source file can
        // hold something the destination cannot. Report it instead of dropping.
        const validation = validateModel(roots, { strict: flags.strict, format: target });
        if (!validation.ok && !flags.force) {
          process.stderr.write(`${formatDiagnostics(validation)}\n`);
          process.exitCode = 1;
          return out(validation, flags);
        }
        const bytes = saveModel(rest[1], roots);
        return out(
          {
            input: rest[0],
            inputFormat: formatFor(rest[0]),
            output: rest[1],
            outputFormat: target,
            bytes,
            validation,
          },
          flags,
        );
      }

      case 'validate': {
        const file = rest[0];
        const roots = loadModel(file);
        const validation = validateModel(roots, {
          strict: flags.strict,
          format: flags.format === 'binary' || flags.format === 'xml' ? flags.format : formatFor(file),
        });
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
        // Two ways to run a script, and they are not interchangeable, so the
        // choice is explicit and its requirements are checked before anything
        // is sent. Studio runs at command-bar permission with physics and the
        // place's own scripts; Open Cloud runs headless on a real server, with
        // that place's scripts deliberately stopped.
        const wantsOpenCloud = flags.backend === 'opencloud' || backend.name === 'opencloud';

        if (wantsOpenCloud) {
          const scriptPath = rest[0];
          if (!scriptPath) throw new Error('exec needs a script path: studio exec run.luau');
          const script = fs.readFileSync(scriptPath, 'utf8');
          const universeId = flags.universe;
          const placeId = flags['place-id'];
          if (!placeId && flags.place) {
            throw new Error(
              'with the opencloud backend the place id is spelled --place-id, because --place means ' +
                `the studio backend's local place file: studio exec ${scriptPath} --backend opencloud ` +
                '--universe 123456 --place-id 987654',
            );
          }
          const missing = [];
          if (!universeId) missing.push('--universe');
          if (!placeId) missing.push('--place-id');
          if (missing.length > 0) {
            throw new Error(
              `opencloud exec needs ${missing.join(' and ')}: studio exec ${scriptPath} ` +
                '--backend opencloud --universe 123456 --place-id 987654 [--place-version 3]',
            );
          }
          if (!opencloud.available()) throw new Error(opencloud.unavailableReason());

          const result = await opencloud.executeLuau({
            script,
            universeId,
            placeId,
            placeVersion: flags['place-version'] ?? null,
            timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
            pollMs: flags.poll ? Number(flags.poll) * 1000 : undefined,
            onPoll: flags.quiet === true ? null : (state) => process.stderr.write(`opencloud ${state}\n`),
          });

          const payload = {
            state: result.state,
            backend: 'opencloud',
            universeId: Number(universeId),
            placeId: Number(placeId),
            placeVersion: parseVersion(result.placeVersion ?? null),
            path: result.path,
            logs: result.logText,
            results: result.output?.results ?? null,
            error: result.error ?? null,
          };

          // The script's own output goes to stderr in human mode, so stdout
          // stays a clean JSON value that a shell pipeline can consume.
          if (result.error) {
            if (flags.quiet !== true && result.logText) process.stderr.write(result.logText);
            if (flags.json) return out(payload, flags);
            throw new Error(`the script failed on the Roblox server: ${JSON.stringify(result.error)}`);
          }
          if (flags.quiet !== true && result.logText) process.stderr.write(result.logText);
          return out(flags.json ? payload : (payload.results ?? null), flags);
        }

        if (backend.name !== 'studio') {
          throw new Error(
            'exec needs the studio backend (Studio --task RunScript), and this host has no Studio.\n' +
              'On Linux or in CI, run it on Roblox\'s own servers instead:\n' +
              '  studio exec run.luau --backend opencloud --universe 123456 --place-id 987654\n' +
              'That needs an Open Cloud API key with the luau-execution scope; see docs/backends.md.',
          );
        }
        const result = await studio.runScript({
          scriptFile: rest[0],
          localPlaceFile: flags.place,
          outputFile: flags.output,
        });
        return out(result, flags);
      }

      case 'deobfuscate': {
        const target = rest[0];
        if (!target) throw new Error('deobfuscate needs a .lua/.luau file');

        // `--detect` answers "is this obfuscated, and how?" without changing
        // anything, which is the question you want answered before trusting the
        // transform on a file you care about.
        let source;
        try {
          source = fs.readFileSync(target, 'utf8');
        } catch (err) {
          throw new Error(`cannot read ${target}: ${err.message}`);
        }

        if (flags.detect) {
          const parsed = parseLuau(source);
          const detection = detectObfuscation(parsed, source, parsed.tokens);
          if (flags.json) return out(detection, flags);
          const lines = [
            detection.obfuscated
              ? `${target}: obfuscation detected (score ${detection.score}/100)`
              : `${target}: no obfuscation detected`,
          ];
          for (const f of detection.findings) {
            lines.push('');
            lines.push(`  [${f.severity}] ${f.technique}: ${f.detail}`);
            if (f.evidence) lines.push(`      evidence: ${f.evidence}`);
            lines.push(`      reversible: ${f.reversible}`);
            if (f.note) lines.push(`      ${f.note.replace(/\s+/g, ' ')}`);
          }
          if (detection.irreversible.length > 0) {
            lines.push('');
            lines.push(`  cannot be undone: ${detection.irreversible.join(', ')}`);
          }
          return out(lines.join('\n'), flags);
        }

        let result;
        try {
          result = deobfuscate(source, {
            rename: flags.rename !== false,
            renameAll: flags['rename-all'] === true,
            fold: flags.fold !== false,
            simplify: flags.simplify !== false,
          });
        } catch (err) {
          if (err instanceof DeobfuscationError) {
            if (flags.json) return out({ ok: false, error: err.message, output: err.code ?? null }, flags);
            throw new Error(err.message);
          }
          if (err && err.name === 'ParseError') {
            throw new Error(
              `${target} could not be parsed, so it was not transformed (${err.message}). ` +
                'Nothing was written.',
            );
          }
          throw err;
        }

        const payload = {
          input: target,
          ...result.report,
          detection: result.detection,
          verification: result.verification,
        };

        if (flags.output) {
          fs.writeFileSync(flags.output, result.code);
          payload.output = flags.output;
          payload.bytes = Buffer.byteLength(result.code);
        }

        if (flags.json) return out(payload, flags);
        if (flags.report) {
          const lines = [
            `${target}:`,
            `  obfuscation score: ${result.detection.score}/100` +
              (result.detection.techniques.length
                ? ` (${result.detection.techniques.join(', ')})`
                : ' (nothing found)'),
            `  strings decoded:   ${result.report.transformations.decodedStrings}`,
            `  constants folded:  ${result.report.transformations.folded}`,
            `  values inlined:    ${result.report.transformations.inlined}`,
            `  branches resolved: ${result.report.transformations.deadBranches + result.report.transformations.liveBranches}`,
            `  loops unwrapped:   ${result.report.transformations.unwrappedLoops}`,
            `  loadstrings:       ${result.report.transformations.loadstringsInlined}`,
            `  decode loops:      ${result.report.transformations.decodedLoops}`,
            `  names renamed:     ${result.report.renames.length}`,
          ];
          if (result.report.renames.length > 0) {
            lines.push('', '  renames (inferred, not recovered):');
            for (const rename of result.report.renames) {
              lines.push(`    ${rename.from} -> ${rename.to}  [${rename.evidence}]`);
            }
          }
          for (const w of result.report.warnings) lines.push(`  warning: ${w.message}`);
          if (result.detection.irreversible.length > 0) {
            lines.push('', `  NOT undone: ${result.detection.irreversible.join(', ')}`);
            for (const f of result.detection.findings) {
              if (f.reversible === 'no') lines.push(`    ${f.technique}: ${f.note}`);
            }
          }
          if (!flags.output) {
            lines.push('', '  (no --output given, so nothing was written)');
          }
          return out(lines.join('\n'), flags);
        }
        if (!flags.output) return out(result.code, flags);
        return out(payload, flags);
      }

      case 'sourcemap': {
        // The file Luau tooling reads to turn `require(script.Parent.Foo)` into
        // a path on disk. Works from a project (matching Rojo) or from a built
        // place (which Rojo cannot do at all).
        const source = rest[0];
        if (!source) throw new Error('sourcemap needs a Rojo project or a model file');
        const ext = path.extname(source).toLowerCase();
        const isModel = ['.rbxm', '.rbxl', '.rbxmx', '.rbxlx'].includes(ext);

        const { sourcemap, warnings } = isModel
          ? sourceMapFromModel(loadModel(source), { includeNonScripts: flags['include-non-scripts'] })
          : sourceMapFromProject(source, { includeNonScripts: flags['include-non-scripts'] });

        for (const w of warnings || []) process.stderr.write(`warning: ${w.message}\n`);

        const json = `${JSON.stringify(sourcemap, null, 2)}\n`;
        if (flags.output) {
          fs.writeFileSync(flags.output, json);
          return out(
            {
              output: flags.output,
              bytes: Buffer.byteLength(json),
              nodes: countNodes(sourcemap),
              scripts: countScripts(sourcemap),
              source: source,
              ...(warnings && warnings.length ? { warnings } : {}),
            },
            flags,
          );
        }
        if (flags.json) return out(sourcemap, flags);
        return out(json.trimEnd(), flags);
      }

      case 'publish': {
        // Convenience: a project or a build spec can be given directly, and it
        // is built first. Anything ending in .rbxl/.rbxlx is published as-is.
        const source = rest[0];
        if (!source) throw new Error('publish needs a place file, a Rojo project, or a build spec');
        const universeId = flags.universe;
        const placeId = flags['place-id'];
        const missing = [];
        if (!universeId) missing.push('--universe');
        if (!placeId) missing.push('--place-id');
        if (missing.length > 0) {
          throw new Error(
            `publish needs ${missing.join(' and ')}: studio publish out.rbxl --universe 123456 ` +
              '--place-id 987654 [--version-type Published|Saved]',
          );
        }
        if (!opencloud.available()) throw new Error(opencloud.unavailableReason('publish'));

        const versionType = flags['version-type'] ?? 'Published';
        const { placeFile, built, builtBytes } = preparePlaceFile(source, flags);

        let result;
        try {
          result = await opencloud.publishPlace({
            placeFile,
            universeId,
            placeId,
            versionType,
          });
        } catch (err) {
          throw new Error(opencloud.explainPublishError(err));
        }

        const payload = {
          universeId: Number(universeId),
          placeId: Number(placeId),
          versionType: result.versionType,
          versionNumber: result.versionNumber,
          bytes: result.bytes,
          placeFile: result.placeFile,
          ...(built ? { builtFrom: source, builtBytes } : {}),
        };
        if (flags.quiet !== true) {
          process.stderr.write(
            `published ${result.placeFile} as ${versionType} version ${result.versionNumber} ` +
              `(place ${placeId}, ${result.bytes} bytes)\n`,
          );
        }
        return out(payload, flags);
      }

      case 'deploy': {
        // The whole loop in one command: build a place from a project or a spec,
        // publish it, then run a script against the version that was just
        // published. Nothing here needs Studio, a GUI, or a Windows machine.
        const source = rest[0];
        if (!source) throw new Error('deploy needs a Rojo project, a build spec, or a place file');
        const universeId = flags.universe;
        const placeId = flags['place-id'];
        const missing = [];
        if (!universeId) missing.push('--universe');
        if (!placeId) missing.push('--place-id');
        if (missing.length > 0) {
          throw new Error(
            `deploy needs ${missing.join(' and ')}: studio deploy default.project.json --universe 123456 ` +
              '--place-id 987654 [--run smoke.luau]',
          );
        }
        if (!opencloud.available()) throw new Error(opencloud.unavailableReason('publish'));

        const versionType = flags['version-type'] ?? 'Published';
        const { placeFile, built, builtBytes } = preparePlaceFile(source, flags);

        let published;
        try {
          published = await opencloud.publishPlace({ placeFile, universeId, placeId, versionType });
        } catch (err) {
          throw new Error(opencloud.explainPublishError(err));
        }
        if (flags.quiet !== true) {
          process.stderr.write(
            `published ${versionType} version ${published.versionNumber} from ${placeFile}` +
              `${built ? ` (built from ${source})` : ''}\n`,
          );
        }

        const runFile = flags.run;
        if (!runFile) {
          return out(
            {
              ...published,
              ...(built ? { builtFrom: source, builtBytes } : {}),
              ran: null,
              note: 'no --run script given, so nothing was executed against the new version',
            },
            flags,
          );
        }

        // Pinned to the version just published, not "latest": if someone else
        // publishes in between, the smoke test must still measure this build.
        const result = await opencloud.executeLuau({
          script: fs.readFileSync(runFile, 'utf8'),
          universeId,
          placeId,
          placeVersion: published.versionNumber,
          timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
          pollMs: flags.poll ? Number(flags.poll) * 1000 : undefined,
        });

        const payload = {
          ...published,
          ...(built ? { builtFrom: source, builtBytes } : {}),
          ran: runFile,
          state: result.state,
          results: result.output?.results ?? null,
          logs: result.logText,
          error: result.error ?? null,
        };

        if (flags.quiet !== true && result.logText) process.stderr.write(result.logText);
        if (result.error) {
          if (flags.json) return out(payload, flags);
          throw new Error(`the smoke test failed: ${JSON.stringify(result.error)}`);
        }
        if (flags.json) return out(payload, flags);
        return out(payload.results ?? null, flags);
      }

      case 'api': {
        const topic = rest[0];
        const term = rest[1];

        // `api dump` is Studio's own dump, and needs Studio.
        if (topic === 'dump') {
          if (backend.name !== 'studio') {
            throw new Error('api dump needs the studio backend (Studio --api/--fullApi/--apiV2).');
          }
          return out(studio.apiDump({ outputFile: flags.output, kind: flags.kind || 'full' }), flags);
        }

        // Everything else is answered from the bundled reflection database, so
        // it works with no Studio and no network.
        if (topic === 'class') {
          if (!term) throw new Error('usage: studio api class <ClassName> [--json]');
          const info = describeClass(term, { all: !!flags.all });
          if (flags.json) return out(info, flags);
          if (!info.found) return notFoundWith(term, info.suggestions, flags);

          // The markers are the point of this listing: `!` means a game script
          // cannot write it, `~` means deprecated, `@` means read-only. Without
          // them an agent sees a property, writes an assignment, and the
          // assignment silently does nothing at runtime.
          const row = (p) => {
            const mark = p.readOnly ? '@' : !p.writableFromGame ? '!' : p.deprecated ? '~' : ' ';
            const notes = [];
            if (p.serializedName && p.serializedName !== p.name) notes.push(`saved as ${p.serializedName}`);
            if (p.writeSecurity && p.writeSecurity !== 'None') notes.push(p.writeSecurity);
            if (p.declaringClass !== info.name) notes.push(`from ${p.declaringClass}`);
            return (
              `  ${mark} ${p.name}${' '.repeat(Math.max(1, 30 - p.name.length))}${p.type}` +
              `${p.enum ? ' (enum)' : ''}${p.referenceTo ? ` -> ${p.referenceTo}` : ''}` +
              `${notes.length > 0 ? `  [${notes.join('; ')}]` : ''}`
            );
          };

          const restricedCount = info.properties.filter((p) => !p.writableFromGame).length;
          const deprecatedCount = info.properties.filter((p) => p.deprecated).length;
          const lines = [
            `${info.name}  (extends ${info.superclass})`,
            info.isService
              ? '  a service: get it with game:GetService'
              : info.creatable
                ? '  creatable: Instance.new works'
                : '  not creatable: the engine provides it',
            ...(info.deprecated ? ['  DEPRECATED by the engine'] : []),
            `  ${info.savedCount} propert${info.savedCount === 1 ? 'y' : 'ies'} saved to model files` +
              (restricedCount > 0 ? `, ${restricedCount} not writable from a game script` : '') +
              (deprecatedCount > 0 ? `, ${deprecatedCount} deprecated` : ''),
            ...info.properties.map(row),
          ];
          if (info.runtimeProperties.length > 0) {
            lines.push('', `  ${info.runtimeOnlyCount} runtime-only (never saved to a file)`);
            lines.push(...info.runtimeProperties.map(row));
          }
          if (info.hiddenProperties) {
            lines.push('', `  ${info.hiddenCount} dump-internal entries (not reachable from a file)`);
            lines.push(...info.hiddenProperties.map(row));
          } else if (info.hiddenCount > 0) {
            lines.push('', `  ${info.hiddenCount} further dump-internal entries; --all lists them`);
          }
          lines.push('', '  ! not writable from a game script   ~ deprecated   @ read-only');
          return out(lines.join('\n'), flags);
        }

        if (topic === 'enum') {
          if (!term) throw new Error('usage: studio api enum <EnumName> [--json]');
          const info = describeEnum(term);
          if (flags.json) return out(info, flags);
          if (!info.found) return notFoundWith(term, info.suggestions, flags);
          const itemLines = info.items.map(
            (i) => `  ${i.deprecated ? '~' : ' '} ${i.name} = ${i.value}`,
          );
          if (info.deprecatedCount > 0) itemLines.push('', '  ~ deprecated by the engine');
          return out(
            [`${info.name}  (${info.count} items)`, ...itemLines].join('\n'),
            flags,
          );
        }

        if (topic === 'property') {
          if (!term) throw new Error('usage: studio api property <PropertyName> [--json]');
          const info = classesWithProperty(term);
          if (flags.json) return out(info, flags);
          if (!info.found) return notFoundWith(term, info.suggestions, flags);
          return out(
            [
              `${info.name}: ${info.type}, declared on ${info.declaringClass}; ` +
                `${info.count} class(es) can hold it`,
              ...info.classes.slice(0, 40).map(
                (c) =>
                  `  ${c.className}${' '.repeat(Math.max(1, 30 - c.className.length))}${c.type}` +
                  `${c.declaringClass === c.className ? '  (declares)' : `  (from ${c.declaringClass})`}`,
              ),
              ...(info.count > 40 ? [`  ... and ${info.count - 40} more`] : []),
            ].join('\n'),
            flags,
          );
        }

        if (topic === 'search') {
          if (!term) throw new Error('usage: studio api search <term> [--json]');
          const result = searchApi(term, { limit: Number(flags.limit) || 40 });
          if (flags.json) return out(result, flags);
          const lines = [
            ...result.classes.map((c) => `class    ${c.name}${c.isService ? '  (service)' : ''}`),
            ...result.enums.map((e) => `enum     ${e.name}  (${e.count} items)`),
            ...result.enumItems.map((i) => `item     ${i.enum}.${i.name} = ${i.value}`),
            ...result.properties.map((p) => `property ${p.name}  ${p.type}  (on ${p.declaringClass})`),
          ];
          if (lines.length === 0) lines.push(`nothing matches "${term}"`);
          else if (result.truncated) lines.push('... more results exist; use --limit');
          return out(lines.join('\n'), flags);
        }

        throw new Error('usage: studio api <class|enum|property|search|dump> <name> [--json]');
      }

      case 'check': {
        const target = rest[0];
        if (!target) throw new Error('usage: studio check <model file | script.luau> [--json]');
        const ext = path.extname(target).toLowerCase();

        if (LUAU_EXTS.has(ext)) {
          // A loose script: no tree, so require targets cannot be resolved.
          const source = fs.readFileSync(target, 'utf8');
          const { diagnostics } = analyzeSource(source, { file: target });
          const result = summarizeScripts(diagnostics, { scripts: 1 });
          if (!result.ok) process.exitCode = 1;
          if (flags.json) return out(result, flags);
          return out(formatScriptDiagnostics(result), flags);
        }

        const roots = loadTarget(target);
        const scripts = scriptsInModel(roots);
        const diagnostics = [];
        for (const script of scripts) {
          const { diagnostics: found } = analyzeSource(script.source, { file: script.path });
          diagnostics.push(...found);
        }
        // With the tree in hand, requires can be resolved for real, and so can
        // `WaitForChild` targets.
        const graph = buildRequireGraph(scripts, roots);
        diagnostics.push(...graph.diagnostics.filter((d) => d.code !== 'dynamic-require'));
        diagnostics.push(...checkTreeBindings(scripts, roots).diagnostics);
        const notes = graph.diagnostics.filter((d) => d.code === 'dynamic-require');
        const result = summarizeScripts(diagnostics, { scripts: scripts.length });
        if (!result.ok) process.exitCode = 1;
        if (flags.json) {
          return out({ ...result, requireEdges: graph.edges.length, cycles: graph.cycles.length, notes }, flags);
        }
        return out(formatScriptDiagnostics(result), flags);
      }

      case 'graph': {
        const target = rest[0];
        if (!target) throw new Error('usage: studio graph <model file | project.json> [--json]');
        const roots = loadTarget(target);
        const graph = buildRequireGraph(scriptsInModel(roots), roots);
        if (flags.json) return out(graph, flags);
        const lines = graph.edges.map((e) => `${e.from} -> ${e.to}`);
        for (const cycle of graph.cycles) lines.push(`CYCLE: ${cycle.join(' -> ')}`);
        lines.push(
          `${graph.scriptCount} script(s), ${graph.edges.length} require edge(s), ${graph.cycles.length} cycle(s)`,
        );
        if (graph.cycles.length > 0) process.exitCode = 1;
        return out(lines.join('\n'), flags);
      }

      case 'refs': {
        const target = rest[0];
        if (!target) throw new Error('usage: studio refs <model file> [--path P] [--broken]');
        const roots = loadTarget(target);
        const graph = referenceGraph(roots);

        // `--path P` scopes to one instance's surroundings: what it points at,
        // and what points back.
        if (flags.path) {
          const index = indexByPath(roots);
          const inst = index.get(flags.path);
          if (!inst) throw new Error(`no instance at ${flags.path}`);
          const outgoing = graph.edges.filter((e) => e.from === flags.path);
          const incoming = graph.incoming.get(flags.path) || [];
          const result = { path: flags.path, className: inst.className, outgoing, incoming };
          if (flags.json) return out(result, flags);
          const lines = [
            `${flags.path} (${inst.className})`,
            ...outgoing.map((e) => `  -> ${e.to}  (${e.property})`),
            ...incoming.map((e) => `  <- ${e.from}  (${e.property})`),
          ];
          if (outgoing.length === 0 && incoming.length === 0) lines.push('  no references either way');
          return out(lines.join('\n'), flags);
        }

        if (flags.broken) {
          if (flags.json) return out({ broken: graph.broken }, flags);
          if (graph.broken.length === 0) return out('ok: no broken references', flags);
          process.exitCode = 1;
          return out(
            graph.broken
              .map((b) => `broken [${b.property}] ${b.from}.${b.property}: ${b.reason}`)
              .concat([`${graph.broken.length} broken reference(s)`])
              .join('\n'),
            flags,
          );
        }

        if (flags.json) return out(graph, flags);
        return out(
          graph.edges.map((e) => `${e.from}.${e.property} -> ${e.to}`).join('\n') +
            `\n${graph.nodes} instance(s), ${graph.edges.length} reference(s), ${graph.broken.length} broken`,
          flags,
        );
      }

      case 'assets': {
        const target = rest[0];
        if (!target) throw new Error('usage: studio assets <model file> [--kind image|sound|mesh] [--json]');
        const inventory = contentInventory(loadTarget(target));
        const items = flags.kind ? inventory.items.filter((i) => i.kind === flags.kind) : inventory.items;
        if (flags.json) return out({ ...inventory, items }, flags);
        const lines = items.map(
          (i) => `${i.kind.padEnd(10)} ${i.raw.padEnd(40)} ${i.path}.${i.property}`,
        );
        lines.push(
          `${items.length} asset reference(s), ${inventory.uniqueAssets} unique, ${inventory.external} external URL(s)`,
        );
        if (inventory.looseUrls.length > 0) {
          // Not asset slots, but worth seeing: a URL where the API did not
          // expect one is often a config indirection worth following.
          lines.push(`${inventory.looseUrls.length} URL(s) in non-content properties:`);
          for (const l of inventory.looseUrls) {
            lines.push(`  ${l.raw}  ${l.path}.${l.property}`);
          }
        }
        return out(lines.join('\n'), flags);
      }

      case 'impact': {
        const target = rest[0];
        const wanted = rest[1];
        if (!target || !wanted) {
          throw new Error('usage: studio impact <model file> <instance path> [--json]');
        }
        const result = impactAnalysis(loadTarget(target), wanted);
        if (flags.json) return out(result, flags);
        if (!result.found) {
          process.exitCode = 1;
          const lines = [`no instance at ${wanted}`];
          if (result.suggestions.length > 0) lines.push(`  maybe: ${result.suggestions.join(', ')}`);
          return out(lines.join('\n'), flags);
        }
        const lines = [
          `${result.path} (${result.className}), ${result.childCount} child(ren)`,
        ];
        if (result.dependsOn.length === 0) {
          lines.push('  nothing in this model references it');
        } else {
          const byDistance = result.dependsOn.slice().sort((a, b) => result.distance[a] - result.distance[b]);
          for (const dep of byDistance) lines.push(`  <${result.distance[dep]}> ${dep}`);
        }
        if (result.scriptMentions.length > 0) {
          lines.push('  scripts that mention it (check by hand):');
          for (const m of result.scriptMentions) {
            lines.push(`    ${m.script}:${m.lines[0].line}  ${m.lines[0].text}`);
          }
        }
        return out(lines.join('\n'), flags);
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
        const validation = validateModel(roots, { format: formatFor(output) });
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
