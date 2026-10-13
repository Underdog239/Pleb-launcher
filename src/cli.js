// studio-cli — Roblox Studio as a command line interface for agents.

import fs from 'node:fs';
import path from 'node:path';
import { listBackends, resolveBackend, local, studio } from './backends/index.js';
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
import { buildRequireGraph, scriptsInModel } from './luau/requires.js';
import { referenceGraph, contentInventory, impactAnalysis, indexByPath } from './rbx/graph.js';

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
  'validate', 'view', 'check', 'graph', 'refs', 'assets', 'impact', 'diff',
  'edit', 'exec', 'api',
  'backends', 'tools', 'call', 'serve', 'proxy', 'doctor',
];

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
        // With the tree in hand, requires can be resolved for real.
        const graph = buildRequireGraph(scripts, roots);
        diagnostics.push(...graph.diagnostics.filter((d) => d.code !== 'dynamic-require'));
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
