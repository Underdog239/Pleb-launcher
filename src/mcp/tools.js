// MCP tool surface.
//
// Tool names intentionally mirror Roblox Studio's built-in MCP server
// (search_game_tree, inspect_instance, script_read, execute_luau, ...) so an
// agent can talk to this CLI exactly as it talks to Studio. Extra tools cover
// what Studio cannot do headlessly (create_model, build, view_scene, convert).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBackend, listBackends, local, opencloud } from '../backends/index.js';
import { loadModel, saveModel, formatFor } from '../rbx/io.js';
import { viewSvg, sceneSummary } from '../backends/local/view.js';
import {
  validateModel,
  formatDiagnostics,
  summarizeDiagnostics,
  closestName,
  coverageReport,
} from '../rbx/validate.js';
import { analyzeSource, summarizeScripts } from '../luau/analyze.js';
import { buildRequireGraph, checkTreeBindings, scriptsInModel } from '../luau/requires.js';
import { referenceGraph, contentInventory, impactAnalysis, indexByPath } from '../rbx/graph.js';
import { describeClass, describeEnum, classesWithProperty, searchApi } from '../rbx/api.js';

/**
 * The studio backend takes a file, so an inline script is written to one.
 *
 * It goes to a temp file rather than anywhere in the workspace, and it is
 * deliberately not deleted until the process exits: Studio reads it
 * asynchronously and may still be holding it open when this call returns.
 */
function writeTempScript(args, script) {
  if (typeof script !== 'string') return undefined;
  const file = path.join(
    os.tmpdir(),
    `studio-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.luau`,
  );
  fs.writeFileSync(file, script);
  return file;
}

/** Read a script file, with an error that says which path failed. */
function readScriptFile(file) {
  if (!file) throw new Error('execute_luau needs either scriptFile or script');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read the script at ${file}: ${err.message}`);
  }
}

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
      'Statically analyse Luau source against the real Roblox API and report problems: unknown classes passed to Instance.new, classes that cannot be created, unknown services, unknown enums and enum items, typos in property names, and deprecated functions. Every diagnostic carries a line, a column, and a suggested fix. Given a model or project it also resolves require() chains and WaitForChild() targets against the real tree, finding missing modules, require cycles, and children the place does not contain. Accepts a model file, a .project.json, a directory, or a single .lua/.luau file. Use this to review generated or edited code before running it.',
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
        // `WaitForChild("X")` where the place has no X: only checkable with the
        // tree in hand, which is why it lives here rather than in the analyser.
        diagnostics.push(...checkTreeBindings(scripts, roots).diagnostics);
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
    name: 'instance_references',
    description:
      'Report the reference graph of a model: which instances point at which through Instance-typed properties (ObjectValue, Adornee, PrimaryPart, attachments, and 300-odd more). Also reports broken references: a reference property set to nothing, or pointing at a class this property cannot hold. Pass a "path" to see one instance\'s surroundings instead of the whole graph.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to a model or place file' },
        project: { type: 'string', description: 'Path to a .project.json to build and analyse instead' },
        path: { type: 'string', description: 'Limit the report to this instance, showing what it points at and what points back' },
        brokenOnly: { type: 'boolean', description: 'Return only the broken references' },
      },
    },
    handler: (args) => {
      const roots = args.project ? local.buildFromProject(args.project).roots : loadRoots(args.file);
      const graph = referenceGraph(roots);
      if (args.brokenOnly) return { broken: graph.broken };
      if (args.path) {
        const inst = indexByPath(roots).get(args.path);
        if (!inst) return { path: args.path, found: false, error: `no instance at ${args.path}` };
        return {
          path: args.path,
          className: inst.className,
          outgoing: graph.edges.filter((e) => e.from === args.path),
          incoming: graph.incoming.get(args.path) || [],
        };
      }
      return {
        nodes: graph.nodes,
        edgeCount: graph.edges.length,
        edges: graph.edges,
        broken: graph.broken,
      };
    },
  },
  {
    name: 'asset_inventory',
    description:
      'List every asset a model references: images, sounds, meshes, animations and skyboxes, with the asset id, the instance and property holding it, and any external (non-Roblox) URL. Use this to audit a place, find missing assets, or see what a build depends on.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to a model or place file' },
        project: { type: 'string', description: 'Path to a .project.json to build and analyse instead' },
        kind: { type: 'string', description: 'Only this kind of asset, e.g. image, sound, mesh, animation' },
      },
    },
    handler: (args) => {
      const roots = args.project ? local.buildFromProject(args.project).roots : loadRoots(args.file);
      const inventory = contentInventory(roots);
      if (!args.kind) return inventory;
      return { ...inventory, items: inventory.items.filter((i) => i.kind === args.kind) };
    },
  },
  {
    name: 'impact_analysis',
    description:
      'Answer "what breaks if I delete this?" before deleting it. Returns everything that references an instance, directly and transitively through the reference graph, ordered by distance, plus the scripts whose source mentions it (presented as mentions to verify, not as proven dependencies).',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to a model or place file' },
        project: { type: 'string', description: 'Path to a .project.json to build and analyse instead' },
        path: { type: 'string', description: 'Full dot path of the instance, e.g. "Workspace.Model.Primary"' },
      },
      required: ['path'],
    },
    handler: (args) => {
      const roots = args.project ? local.buildFromProject(args.project).roots : loadRoots(args.file);
      return impactAnalysis(roots, args.path);
    },
  },
  {
    name: 'format_coverage',
    description:
      'Report which property value types this toolchain can write to binary and to XML, and name the ones it cannot. Ask this before a conversion or a build to know whether anything will be lost; the answer comes from the codecs themselves, not from a hand-maintained list.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['binary', 'xml'], description: 'Limit the answer to one format' },
      },
    },
    handler: (args) => {
      const coverage = coverageReport();
      if (args.format) return { totalTypes: coverage.totalTypes, [args.format]: coverage[args.format] };
      return coverage;
    },
  },
  {
    name: 'api_lookup',
    description:
      'Answer questions about the Roblox API itself, with no Studio and no network: what properties a class has and what type each one is, whether they are saved to model files or runtime-only, the members of an enum with their numeric values, which classes can hold a given property, and free-text search across classes, enums, enum items and properties. Use this to write correct code before checking it, e.g. to confirm a property name, its type, or that Instance.new works for a class.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['class', 'enum', 'property', 'search'],
          description: 'class = one class and its properties; enum = one enum and its items; property = which classes hold it; search = free text',
        },
        name: { type: 'string', description: 'Class name, enum name, property name, or search term' },
        all: { type: 'boolean', description: 'For kind=class: also list dump-internal entries that are not reachable from a file' },
        limit: { type: 'integer', description: 'For kind=search: maximum results per category (default 40)' },
      },
      required: ['kind', 'name'],
    },
    handler: (args) => {
      switch (args.kind) {
        case 'class':
          return describeClass(args.name, { all: !!args.all });
        case 'enum':
          return describeEnum(args.name);
        case 'property':
          return classesWithProperty(args.name);
        case 'search':
          return searchApi(args.name, { limit: args.limit || 40 });
        default:
          throw new Error(`kind must be one of class, enum, property, search; got ${JSON.stringify(args.kind)}`);
      }
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
      'Actually run Luau and get its output, rather than reading it. Two backends: "studio" runs the script in a local Studio at command-bar permission, with physics and the place\'s scripts; "opencloud" runs it on a real Roblox server with the place loaded, headless and with the place\'s own scripts stopped. The local backend cannot run engine Luau at all.',
    inputSchema: {
      type: 'object',
      properties: {
        scriptFile: { type: 'string', description: 'Path to a .lua/.luau file to run' },
        script: { type: 'string', description: 'Inline script, instead of scriptFile' },
        backend: {
          type: 'string',
          enum: ['studio', 'opencloud'],
          description: 'Where to run. Defaults to whichever is available.',
        },
        universeId: { type: 'integer', description: 'Experience id (opencloud)' },
        placeId: { type: 'integer', description: 'Place id (opencloud)' },
        placeVersion: { type: 'integer', description: 'Place version; latest if omitted (opencloud)' },
        localPlaceFile: { type: 'string' },
        outputFile: { type: 'string' },
        timeoutSeconds: { type: 'integer' },
      },
    },
    handler: async (args, ctx) => {
      const canStudio = ctx.backend.name === 'studio';
      const wants = args.backend || (canStudio ? 'studio' : opencloud.available() ? 'opencloud' : null);

      if (wants === 'opencloud') {
        if (!opencloud.available()) throw new Error(opencloud.unavailableReason());
        const script = args.script ?? readScriptFile(args.scriptFile);
        if (!args.universeId || !args.placeId) {
          throw new Error(
            'the opencloud backend needs universeId and placeId (the experience and place to load)',
          );
        }
        const result = await opencloud.executeLuau({
          script,
          universeId: args.universeId,
          placeId: args.placeId,
          placeVersion: args.placeVersion ?? null,
          timeoutMs: args.timeoutSeconds ? args.timeoutSeconds * 1000 : undefined,
        });
        return {
          state: result.state,
          backend: 'opencloud',
          placeVersion: result.placeVersion ?? null,
          logs: result.logText,
          results: result.output?.results ?? null,
          error: result.error ?? null,
        };
      }

      if (wants === 'studio') {
        if (!canStudio) {
          throw new Error(
            'the studio backend is not available on this host (no Studio installed).\n' +
              'Open Cloud can run Luau headlessly instead: pass backend "opencloud" with ' +
              'universeId and placeId, and set ROBLOX_CLOUD_API_KEY.',
          );
        }
        // Studio's CLI takes a file, so an inline script is written to one.
        const scriptFile = args.scriptFile ?? writeTempScript(args, args.script);
        if (!scriptFile) throw new Error('execute_luau needs either scriptFile or script');
        return ctx.backend.runScript({ ...args, scriptFile });
      }

      throw new Error(
        'execute_luau has nowhere to run: no Studio on this host and no Open Cloud API key.\n' +
          'Set ROBLOX_CLOUD_API_KEY (scope universe.place.luau-execution-session:write) and pass ' +
          'backend "opencloud" with universeId and placeId.',
      );
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
