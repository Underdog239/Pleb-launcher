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
import { validateModel, formatDiagnostics, summarizeDiagnostics, closestName } from '../rbx/validate.js';
import { analyzeSource, summarizeScripts } from '../luau/analyze.js';
import { buildRequireGraph, scriptsInModel } from '../luau/requires.js';

/**
 * Load the model a tool was pointed at.
 *
 * There is deliberately no default: fabricating an empty `Workspace` here would
 * make a tool call with a typo'd or missing `file` look like it succeeded on an
 * empty place, which is exactly the silent-wrong-answer failure this project
 * exists to avoid.
 */
function loadRoots(file) {
  if (!file || typeof file !== 'string') {
    throw new Error(
      'missing "file": pass the path to a .rbxm/.rbxl/.rbxmx/.rbxlx model or place file',
    );
  }
  return loadModel(file);
}

const FILE_PROP = {
  file: {
    type: 'string',
    description: 'Path to a .rbxm/.rbxl (binary) or .rbxmx/.rbxlx (XML) model or place file',
  },
};

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
        ...FILE_PROP,
        path: { type: 'string', description: 'Dot path to start from, e.g. "Workspace.Model"' },
        depth: { type: 'integer', description: 'Maximum depth to expand' },
      },
      required: ['file'],
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
        ...FILE_PROP,
        path: { type: 'string', description: 'Dot path, e.g. "Workspace.Part"' },
      },
      required: ['file', 'path'],
    },
    handler: (args) => local.inspect(loadRoots(args.file), args.path),
  },
  {
    name: 'script_read',
    description: 'Read a script instance source. Mirrors Studio MCP script_read.',
    inputSchema: {
      type: 'object',
      properties: { ...FILE_PROP, path: { type: 'string', description: 'Dot path of the script' } },
      required: ['file', 'path'],
    },
    handler: (args) => local.readScript(loadRoots(args.file), args.path),
  },
  {
    name: 'model_stats',
    description: 'Summarise a model: total instance count and a breakdown by class.',
    inputSchema: { type: 'object', properties: { ...FILE_PROP }, required: ['file'] },
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
        strict: { type: 'boolean', description: 'Also fail on warnings' },
      },
      required: ['output'],
    },
    handler: (args) => {
      const spec = args.spec || JSON.parse(fs.readFileSync(args.specFile, 'utf8'));
      const roots = local.modelFromSpec(spec);
      const validation = validateModel(roots, { strict: !!args.strict, format: formatFor(args.output) });
      if (!validation.ok) {
        // Refuse to write a model we know is wrong; surface the diagnostics.
        throw new Error(formatDiagnostics(validation));
      }
      const bytes = saveModel(args.output, roots);
      return {
        output: args.output,
        bytes,
        roots: roots.map((r) => r.getFullName()),
        validation,
      };
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
        strict: { type: 'boolean', description: 'Also fail on warnings' },
      },
      required: ['project', 'output'],
    },
    handler: (args) => {
      const { roots, projectName, warnings } = local.buildFromProject(args.project);
      const validation = validateModel(roots, { strict: !!args.strict, format: formatFor(args.output) });
      if (!validation.ok) throw new Error(formatDiagnostics(validation));
      const bytes = saveModel(args.output, roots);
      return {
        output: args.output,
        bytes,
        projectName,
        stats: local.stats(roots),
        validation,
        ...(warnings && warnings.length ? { projectWarnings: warnings } : {}),
      };
    },
  },
  {
    name: 'validate_model',
    description:
      'Validate a model file (or an inline spec) and return structured diagnostics: unknown properties with suggestions, wrong value types, invalid enum items, invalid references, and out-of-range values. Use this before trusting a model.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to a model file to validate' },
        spec: { type: 'object', description: 'Instance spec to validate instead of a file' },
        format: { type: 'string', enum: ['binary', 'xml'], description: 'Target format to check write coverage against' },
        strict: { type: 'boolean', description: 'Treat warnings as failures' },
      },
    },
    handler: (args) => {
      const roots = args.spec ? local.modelFromSpec(args.spec) : loadRoots(args.file);
      // Without an explicit target, check the file's own format; an inline spec
      // has no destination yet, so the strictest format is assumed.
      const format = args.format || (args.file ? formatFor(args.file) : 'binary');
      const result = validateModel(roots, { strict: !!args.strict, format });
      return { ...result, summary: formatDiagnostics(result) };
    },
  },
  {
    name: 'script_check',
    description:
      'Statically analyse Luau source against the real Roblox API and report problems: unknown classes passed to Instance.new, classes that cannot be created, unknown services, unknown enums and enum items, typos in property names, and deprecated functions. Every diagnostic carries a line, a column, and a suggested fix. Accepts a model file (every script inside it is checked), a directory, or a single .lua/.luau file. Use this to review generated or edited code before running it.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to a model file, a .lua/.luau source file, or a directory of scripts' },
        source: { type: 'string', description: 'Luau source to check directly, instead of a file' },
        project: { type: 'string', description: 'Path to a .project.json; every script it builds is checked with its tree intact' },
        includeRequires: {
          type: 'boolean',
          description: 'When checking a model or project, also resolve require() chains and report missing targets, non-module targets, and cycles (default true)',
        },
      },
    },
    handler: (args) => {
      if (typeof args.source === 'string') {
        const { diagnostics, errors } = analyzeSource(args.source, { file: 'input.luau' });
        const result = summarizeScripts(diagnostics, { scripts: 1 });
        return { ...result, lexErrors: errors };
      }

      const roots = args.project ? local.buildFromProject(args.project).roots : loadRoots(args.file);
      const scripts = scriptsInModel(roots);
      const diagnostics = [];
      for (const script of scripts) {
        const { diagnostics: found } = analyzeSource(script.source, { file: script.path });
        diagnostics.push(...found);
      }

      let graph = null;
      if (args.includeRequires !== false) {
        graph = buildRequireGraph(scripts, roots);
        diagnostics.push(...graph.diagnostics);
      }
      const result = summarizeScripts(diagnostics, { scripts: scripts.length });
      return {
        ...result,
        ...(graph ? { requireEdges: graph.edges.length, cycles: graph.cycles } : {}),
      };
    },
  },
  {
    name: 'require_graph',
    description:
      'Build the require() graph of a place: which script requires which, as concrete instance paths. Reports edges, cycles, and scripts whose requires are computed at runtime and therefore not knowable statically.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to a model or place file' },
        project: { type: 'string', description: 'Path to a .project.json to build and analyse instead' },
      },
    },
    handler: (args) => {
      const roots = args.project ? local.buildFromProject(args.project).roots : loadRoots(args.file);
      const graph = buildRequireGraph(scriptsInModel(roots), roots);
      return {
        scriptCount: graph.scriptCount,
        edges: graph.edges,
        cycles: graph.cycles,
        nodes: graph.nodes,
        diagnostics: graph.diagnostics,
      };
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
        ...FILE_PROP,
        format: { type: 'string', enum: ['svg', 'json'] },
        output: { type: 'string', description: 'Optional path to write the SVG to' },
        plane: { type: 'string', enum: ['xz', 'xy', 'zy'] },
      },
      required: ['file'],
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

  {
    name: 'script_grep',
    description:
      'Search the source of every script in a model for a text or regex pattern. Mirrors Studio MCP script_grep, but reads a model file instead of a live DataModel. Returns each match with its instance path, line and column.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        pattern: { type: 'string', description: 'RegExp source, or literal text when fixed=true' },
        path: { type: 'string', description: 'Restrict the search to a subtree, e.g. "ServerScriptService"' },
        fixed: { type: 'boolean', description: 'Treat pattern as literal text, not a regex' },
        ignoreCase: { type: 'boolean' },
        limit: { type: 'integer', description: 'Maximum matches returned (default 200)' },
      },
      required: ['file', 'pattern'],
    },
    handler: (args) =>
      local.scriptGrep(loadRoots(args.file), args.pattern, {
        fixed: !!args.fixed,
        ignoreCase: !!args.ignoreCase,
        path: args.path,
        limit: args.limit,
      }),
  },
  {
    name: 'diff_models',
    description:
      'Compare two models structurally and report what was added, removed and changed (per property). Use this to verify an edit did what you intended.',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'string', description: 'Path to the original model file' },
        after: { type: 'string', description: 'Path to the edited model file' },
      },
      required: ['before', 'after'],
    },
    handler: (args) => local.diffModels(loadModel(args.before), loadModel(args.after)),
  },
  {
    name: 'multi_edit',
    description:
      'Edit script sources in a model: replace a whole script with "source", or a snippet with "find"/"replace". Mirrors Studio MCP multi_edit. Every edit is resolved and checked before any is applied, so a bad path cannot leave the model half-edited. Writes to "output" (default: the input file) only if nothing errored.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Path to the model file to edit' },
        output: { type: 'string', description: 'Where to write the result (default: overwrite input)' },
        edits: {
          type: 'array',
          description: 'One entry per script: { path, source } or { path, find, replace, all }',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Dot path of the script, e.g. "ServerScriptService.Main"' },
              source: { type: 'string', description: 'Replacement source for the whole script' },
              find: { type: 'string', description: 'Snippet to replace' },
              replace: { type: 'string', description: 'Replacement for find' },
              all: { type: 'boolean', description: 'Replace every occurrence of find' },
            },
            required: ['path'],
          },
        },
        force: { type: 'boolean', description: 'Apply the edits that are valid even if others failed' },
      },
      required: ['input', 'edits'],
    },
    handler: (args) => {
      const roots = loadModel(args.input);
      const edits = local.applyScriptEdits(roots, args.edits, { force: !!args.force });
      if (!edits.ok && !args.force) {
        // Refuse to write a half-applied edit set; surface every problem at once.
        throw new Error(formatDiagnostics(summarizeDiagnostics(edits.diagnostics)));
      }
      const output = args.output || args.input;
      const validation = validateModel(roots, { format: formatFor(output) });
      if (!validation.ok) throw new Error(formatDiagnostics(validation));
      const bytes = saveModel(output, roots);
      return {
        output,
        bytes,
        edits: edits.files,
        skipped: edits.diagnostics,
        validation,
      };
    },
  },
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
  if (!tool) {
    // Same contract as the validator: never just say "no", say what you meant.
    const suggestion = closestName(String(name), tools.map((t) => t.name));
    throw new Error(
      `unknown tool: ${name}${suggestion ? ` — did you mean ${suggestion}?` : ''} ` +
        `(available: ${tools.map((t) => t.name).join(', ')})`,
    );
  }
  const ctx = { backend: resolveBackend(backend), backendName: backend };
  return tool.handler(args || {}, ctx);
}
