// Studio backend: drives a real Roblox Studio installation.
//
// Studio exposes a documented CLI (--task RunScript, --api, ...) and a built-in
// MCP server over stdio. This backend wraps both, giving full engine fidelity
// (real physics, real rendering, real services) at the cost of requiring
// Windows/macOS with Studio installed. See docs/backends.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const name = 'studio';
export const capabilities = {
  executeLuau: true,
  physics: true,
  render: 'engine',
  requiresStudio: true,
  platform: process.platform,
};

/** Locate the Studio executable for this platform, or null. */
export function studioPath() {
  if (process.env.ROBLOX_STUDIO_PATH) return process.env.ROBLOX_STUDIO_PATH;
  if (process.platform === 'darwin') {
    const p = '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio';
    return fs.existsSync(p) ? p : null;
  }
  if (process.platform === 'win32') {
    const base = path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'Versions');
    if (!fs.existsSync(base)) return null;
    const versions = fs
      .readdirSync(base)
      .map((v) => path.join(base, v, 'RobloxStudioBeta.exe'))
      .filter((p) => fs.existsSync(p));
    return versions[0] || null;
  }
  return null;
}

/** Locate the Studio MCP server entrypoint for this platform, or null. */
export function mcpServerPath() {
  if (process.env.ROBLOX_STUDIO_MCP_PATH) return process.env.ROBLOX_STUDIO_MCP_PATH;
  if (process.platform === 'darwin') {
    const p = '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP';
    return fs.existsSync(p) ? p : null;
  }
  if (process.platform === 'win32') {
    const p = path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'mcp.bat');
    return fs.existsSync(p) ? p : null;
  }
  return null;
}

export function available() {
  return studioPath() !== null || mcpServerPath() !== null;
}

function requireStudio() {
  const p = studioPath();
  if (!p) {
    throw new Error(
      'Roblox Studio was not found. The "studio" backend requires Studio on Windows or macOS. ' +
        'Set ROBLOX_STUDIO_PATH to override, or use --backend local.',
    );
  }
  return p;
}

/** Build the argv Studio's documented CLI expects for a task. */
export function buildArgs(options) {
  const args = [];
  if (options.placeId) {
    args.push('--placeId', String(options.placeId));
    if (options.universeId) args.push('--universeId', String(options.universeId));
    args.push('--task', options.task || (options.placeVersion ? 'EditPlaceRevision' : 'EditPlace'));
    if (options.placeVersion) args.push('--placeVersion', String(options.placeVersion));
  } else if (options.localPlaceFile) {
    args.push('--task', 'EditFile', '--localPlaceFile', path.resolve(options.localPlaceFile));
  } else if (options.task) {
    args.push('--task', options.task);
  }
  return args;
}

/** Run a Luau file inside Studio at command-bar permission. */
export function runScript({ scriptFile, placeId, universeId, localPlaceFile, outputFile, timeoutMs = 300000 }) {
  const exe = requireStudio();
  const args = buildArgs({ placeId, universeId, localPlaceFile, task: 'RunScript' });
  if (!args.includes('--task')) args.push('--task', 'RunScript');
  args.push('--runScriptFile', path.resolve(scriptFile));
  if (outputFile) args.push('--outputFile', path.resolve(outputFile));
  args.push('--quitAfterExecution');

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Studio RunScript timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const fileOutput = outputFile && fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : null;
      resolve({ exitCode: code, stdout, stderr, output: fileOutput });
    });
  });
}

/** Dump Studio's API surface to JSON via --api / --fullApi / --apiV2. */
export function apiDump({ outputFile, kind = 'full' } = {}) {
  const exe = requireStudio();
  const flag = kind === 'script' ? '--api' : kind === 'v2' ? '--apiV2' : '--fullApi';
  const out = path.resolve(outputFile || path.join(os.tmpdir(), `rbx-api-${Date.now()}.json`));
  const res = spawnSync(exe, [flag, out], { encoding: 'utf8' });
  return { exitCode: res.status, outputFile: out, exists: fs.existsSync(out), stderr: res.stderr || '' };
}

/** Open a place/script in Studio for interactive editing. */
export function open(options) {
  const exe = requireStudio();
  const args = buildArgs({ ...options, task: options.task || 'EditPlace' });
  if (options.openScriptPath) args.push('--openScriptPath', options.openScriptPath);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { launched: true, argv: args };
}

/**
 * Spawn Studio's built-in MCP server and proxy stdio to it.
 * Returns the child process so callers can bridge streams.
 */
export function spawnMcpProxy() {
  const mcp = mcpServerPath();
  if (!mcp) {
    throw new Error('Roblox Studio MCP server not found. Enable it in Studio (Assistant > Manage MCP Servers).');
  }
  const command = process.platform === 'win32' ? 'cmd.exe' : mcp;
  const args = process.platform === 'win32' ? ['/c', mcp] : [];
  return spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
}
