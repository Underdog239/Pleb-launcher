// MCP tool surface.
//
// Tool names intentionally mirror Roblox Studio's built-in MCP server
// (search_game_tree, inspect_instance, script_read, execute_luau, ...) so an
// agent can talk to this CLI exactly as it talks to Studio. Extra tools cover
// what Studio cannot do headlessly (create_model, build, view_scene, convert).

import fs from 'node:fs';
import { resolveBackend, listBackends, local } from '../backends/index.js';
import { loadModel, saveModel, formatFor } from '../rbx/io.js';
import { viewSvg, sceneSummary } from '../backends/local/view.js';
import { Instance } from '../rbx/instance.js';

function loadRoots(file) {
  if (!file) return [new Instance('Folder', 'Workspace')];
  return loadModel(file);
}

export const tools = [
  {
    name: 'backend_info',
    description: 'List available backends (local, studio) and report which one is active.',
    inputSchema: { type: 'object', properties: {} },
    handler: (args, ctx) => ({
      active: ctx.backend.name,
      capabilities: ctx.backend.capabilities,
      backends: listBackends(),
    }),
  },
  {
    name: 'search_game_tree',
    description:
      'Explore the instance hierarchy of a model/place file as a JSON tree. Mirrors Studio MCP search_game_tree.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to a .rbxm/.rbxl/.rbxmx/.rbxlx file' },
        path: { type: 'string', description: 'Dot path to start from, e.g. "Workspace.Model"' },
        depth: { type: 'integer', description: 'Maximum depth to expand' },
      },
    },
    handler: (args) => local.tree(loadRoots(args.file), { path: args.path || '', depth: args.depth ?? null }),
  },
  {
    name: 'inspect_instance',
    description:
      'Return all properties of a single instance, including serialization details. Mirrors Studio MCP inspect_instance.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        path: { type: 'string', description: 'Dot path, e.g. "Workspace.Part"' },
      },
      required: ['path'],
    },
    handler: (args) => local.inspect(loadRoots(args.file), args.path),
  },
  {
    name: 'script_read',
    description: 'Read a script instance source. Mirrors Studio MCP script_read.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' }, path: { type: 'string' } },
      required: ['path'],
    },
    handler: (args) => local.readScript(loadRoots(args.file), args.path),
  },
  {
    name: 'model_stats',
    description: 'Summarise a model: total instance count and a breakdown by class.',
    inputSchema: { type: 'object', properties: { file: { type: 'string' } } },
    handler: (args) => local.stats(loadRoots(args.file)),
  },
  {
    name: 'create_model',
    description:
      'Create a .rbxm/.rbxmx/.rbxl/.rbxlx file from a JSON instance spec. This is how agents author content.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'Instance spec: { className, name, properties, children }' },
        specFile: { type: 'string', description: 'Path to a JSON spec file (alternative to spec)' },
        output: { type: 'string', description: 'Output model file path' },
      },
      required: ['output'],
    },
    handler: (args) => {
      const spec = args.spec || JSON.parse(fs.readFileSync(args.specFile, 'utf8'));
      const roots = local.modelFromSpec(spec);
      const bytes = saveModel(args.output, roots);
      return { output: args.output, bytes, roots: roots.map((r) => r.getFullName()) };
    },
  },
  {
    name: 'build',
    description: 'Build a Rojo-style project.json into a model/place file.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Path to project JSON' },
        output: { type: 'string' },
      },
      required: ['project', 'output'],
    },
    handler: (args) => {
      const { roots, projectName } = local.buildFromProject(args.project);
      const bytes = saveModel(args.output, roots);
      return { output: args.output, bytes, projectName, stats: local.stats(roots) };
    },
  },
  {
    name: 'convert',
    description: 'Convert a model file between binary (.rbxm/.rbxl) and XML (.rbxmx/.rbxlx).',
    inputSchema: {
      type: 'object',
      properties: { input: { type: 'string' }, output: { type: 'string' } },
      required: ['input', 'output'],
    },
    handler: (args) => {
      const roots = loadModel(args.input);
      const bytes = saveModel(args.output, roots);
      return {
        input: args.input,
        inputFormat: formatFor(args.input),
        output: args.output,
        outputFormat: formatFor(args.output),
        bytes,
      };
    },
  },
  {
    name: 'view_scene',
    description:
      'Produce an approximate top-down visualisation of the BaseParts in a model, so an agent can perceive layout. Returns SVG text or a JSON summary.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        format: { type: 'string', enum: ['svg', 'json'] },
        output: { type: 'string', description: 'Optional path to write the SVG to' },
        plane: { type: 'string', enum: ['xz', 'xy', 'zy'] },
      },
    },
    handler: (args) => {
      const roots = loadRoots(args.file);
      if (args.format === 'json') return sceneSummary(roots);
      const svg = viewSvg(roots, { plane: args.plane || 'xz' });
      if (args.output) {
        fs.writeFileSync(args.output, svg);
        return { output: args.output, bytes: svg.length, note: 'approximate projection, not an engine render' };
      }
      return { svg, note: 'approximate projection, not an engine render' };
    },
  },
  {
    name: 'execute_luau',
    description:
      'Execute Luau with full engine fidelity. Requires the studio backend (Studio on Windows/macOS); the local backend cannot run engine Luau.',
    inputSchema: {
      type: 'object',
      properties: {
        scriptFile: { type: 'string', description: 'Path to a .lua/.luau file to run' },
        placeId: { type: 'integer' },
        universeId: { type: 'integer' },
        localPlaceFile: { type: 'string' },
        outputFile: { type: 'string' },
      },
      required: ['scriptFile'],
    },
    handler: async (args, ctx) => {
      if (ctx.backend.name !== 'studio') {
        throw new Error(
          'execute_luau needs the studio backend. Studio runs Luau at command-bar permission via ' +
            '--task RunScript. On Linux there is no Studio; use Open Cloud Luau Execution instead.',
        );
      }
      return ctx.backend.runScript(args);
    },
  },
  {
    name: 'api_dump',
    description: "Dump Studio's API surface to JSON. Requires the studio backend.",
    inputSchema: {
      type: 'object',
      properties: {
        outputFile: { type: 'string' },
        kind: { type: 'string', enum: ['script', 'full', 'v2'] },
      },
    },
    handler: (args, ctx) => {
      if (ctx.backend.name !== 'studio') {
        throw new Error('api_dump needs the studio backend (Studio --api/--fullApi/--apiV2).');
      }
      return ctx.backend.apiDump(args);
    },
  },

  // @@TOOLS2@@
];

export function findTool(name) {
  return tools.find((t) => t.name === name) || null;
}

export function toolList() {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** Execute a tool by name against the resolved backend. */
export async function callTool(name, args, { backend = 'auto' } = {}) {
  const tool = findTool(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  const ctx = { backend: resolveBackend(backend), backendName: backend };
  return tool.handler(args || {}, ctx);
}
