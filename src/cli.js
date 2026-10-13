// studio-cli — Roblox Studio as a command line interface for agents.

import fs from 'node:fs';
import { listBackends, resolveBackend, local, studio } from './backends/index.js';
import { loadModel, saveModel, formatFor } from './rbx/io.js';
import { viewSvg, sceneSummary } from './backends/local/view.js';
import { runStdioServer } from './mcp/server.js';
import { toolList, callTool } from './mcp/tools.js';

const VERSION = '0.1.0';

const USAGE = `studio-cli ${VERSION} — Roblox Studio as a CLI/MCP server for agents

USAGE
  studio <command> [options]

COMMANDS
  tree <file> [--path P] [--depth N]     Instance hierarchy as JSON
  inspect <file> <path>                  All properties of one instance
  read <file> <path>                     Script source
  stats <file>                           Instance counts by class
  build <project.json> -o <out>          Build a Rojo-style project
  model <spec.json> -o <out>             Create a model from a JSON spec
  convert <in> <out>                     Convert binary <-> XML model files
  view <file> [-o out.svg] [--format F]  Approximate top-down visualisation
  exec <script.luau> [--place F]         Run Luau in Studio (studio backend)
  api dump [-o out.json]                 Dump Studio's API surface
  backends                               List backends and capabilities
  tools                                  List MCP tools
  call <tool> [json]                     Invoke an MCP tool directly
  serve                                  Run the MCP server on stdio

GLOBAL OPTIONS
  --backend <auto|local|studio>   Which engine to use (default: auto)
  --json                          Machine-readable output only
  -h, --help                      Show this help
  -v, --version                   Show version

Model files: .rbxm .rbxl (binary) and .rbxmx .rbxlx (XML).
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '-v' || a === '--version') flags.version = true;
    else if (a === '-o' || a === '--output') flags.output = argv[++i];
    else if (a === '--path') flags.path = argv[++i];
    else if (a === '--depth') flags.depth = Number(argv[++i]);
    else if (a === '--format') flags.format = argv[++i];
    else if (a === '--plane') flags.plane = argv[++i];
    else if (a === '--place') flags.place = argv[++i];
    else if (a === '--backend') flags.backend = argv[++i];
    else if (a === '--json') flags.json = true;
    else if (a === '--spec') flags.spec = argv[++i];
    else if (a === '--kind') flags.kind = argv[++i];
    else positional.push(a);
  }
  return { positional, flags };
}

function out(value, flags) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  process.stdout.write(`${text}\n`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}

export async function run(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
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

      case 'serve':
        runStdioServer({ backend: flags.backend || 'auto' });
        return undefined;

      case 'tree': {
        const roots = loadModel(rest[0]);
        return out(local.tree(roots, { path: flags.path || '', depth: flags.depth ?? null }), flags);
      }

      case 'inspect':
        return out(local.inspect(loadModel(rest[0]), rest[1]), flags);

      case 'read':
        return out(local.readScript(loadModel(rest[0]), rest[1]), flags);

      case 'stats':
        return out(local.stats(loadModel(rest[0])), flags);

      case 'build': {
        const { roots, projectName } = local.buildFromProject(rest[0]);
        const target = flags.output || 'out.rbxl';
        const bytes = saveModel(target, roots);
        return out({ output: target, bytes, projectName, stats: local.stats(roots) }, flags);
      }

      case 'model': {
        const spec = JSON.parse(fs.readFileSync(flags.spec || rest[0], 'utf8'));
        const target = flags.output || 'out.rbxm';
        const roots = local.modelFromSpec(spec);
        const bytes = saveModel(target, roots);
        return out({ output: target, bytes, roots: roots.map((r) => r.getFullName()) }, flags);
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

      // @@CLI2@@
      default:
        throw new Error(`unknown command: ${command}\n\n${USAGE}`);
    }
  } catch (err) {
    fail(err?.message || String(err));
    return undefined;
  }
}
