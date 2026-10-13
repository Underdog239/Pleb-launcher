import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { frameMessage } from '../src/mcp/server.js';
import { proxyStdio } from '../src/mcp/proxy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'studio.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-test-'));

function serve(input) {
  return spawnSync(process.execPath, [CLI, 'serve'], { encoding: 'utf8', input, cwd: tmp });
}

function jsonlMessages(stdout) {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function lspFrame(obj) {
  return frameMessage(obj, 'lsp');
}

// --- framing ----------------------------------------------------------------

test('newline-delimited requests get newline-delimited replies', () => {
  const res = serve(
    [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      '',
    ].join('\n'),
  );
  const messages = jsonlMessages(res.stdout);
  assert.equal(messages[0].result.serverInfo.name, 'studio-cli');
  assert.equal(messages[1].result !== undefined, true);
});

test('Content-Length framed requests get Content-Length framed replies', () => {
  // A client that speaks LSP framing cannot parse a newline-delimited reply.
  const res = serve(
    lspFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) +
      lspFrame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  );

  const frames = [];
  let rest = res.stdout;
  while (rest.startsWith('Content-Length:')) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    const length = Number(rest.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i)[1]);
    const start = headerEnd + 4;
    const body = Buffer.from(rest.slice(start), 'utf8').subarray(0, length).toString('utf8');
    frames.push(JSON.parse(body));
    rest = Buffer.from(rest.slice(start), 'utf8').subarray(length).toString('utf8');
  }

  assert.equal(frames.length, 2, `expected 2 framed replies, got: ${JSON.stringify(rest)}`);
  assert.equal(frames[0].result.serverInfo.name, 'studio-cli');
  assert.ok(frames[1].result.tools.length > 0);
});

test('frameMessage measures the body in bytes', () => {
  const frame = frameMessage({ text: '☃' }, 'lsp');
  const body = frame.slice(frame.indexOf('\r\n\r\n') + 4);
  assert.equal(Number(frame.match(/Content-Length: (\d+)/)[1]), Buffer.byteLength(body, 'utf8'));
});

// --- tool surface -----------------------------------------------------------

test('a tool that needs a file says so instead of inventing an empty place', () => {
  const res = serve(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_game_tree', arguments: {} },
    })}\n`,
  );
  const message = jsonlMessages(res.stdout)[0];
  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /missing "file"/);
});

test('an unknown tool name gets a suggestion and the tool list', () => {
  const res = serve(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'creat_modl', arguments: {} },
    })}\n`,
  );
  const message = jsonlMessages(res.stdout)[0];
  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /did you mean create_model\?/);
  assert.match(message.result.content[0].text, /available: backend_info/);
});

test('file-taking tools declare file as required', () => {
  const res = serve(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  const tools = jsonlMessages(res.stdout)[0].result.tools;
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const name of ['search_game_tree', 'inspect_instance', 'script_read', 'model_stats', 'view_scene', 'script_grep']) {
    assert.ok(byName.get(name).inputSchema.required.includes('file'), `${name} should require file`);
  }
  assert.ok(byName.has('script_grep'));
  assert.ok(byName.has('diff_models'));
  assert.ok(byName.has('multi_edit'));
});

// --- new tools end to end ---------------------------------------------------

function makePlace(file) {
  const specPath = path.join(tmp, `${path.basename(file)}.json`);
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      className: 'Folder',
      name: 'Root',
      children: [
        { className: 'Script', name: 'Main', properties: { Source: 'print("one")\nprint("two")\n' } },
        { className: 'ModuleScript', name: 'Util', properties: { Source: 'return 1\n' } },
      ],
    }),
  );
  const res = spawnSync(process.execPath, [CLI, 'model', specPath, '-o', file], { encoding: 'utf8', cwd: tmp });
  assert.equal(res.status, 0, res.stderr);
}

test('script_grep finds matches with line and column through MCP', () => {
  const file = path.join(tmp, 'grep-place.rbxm');
  makePlace(file);
  const res = serve(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'script_grep', arguments: { file, pattern: 'print\\("t' } },
    })}\n`,
  );
  const result = JSON.parse(jsonlMessages(res.stdout)[0].result.content[0].text);
  assert.equal(result.matchCount, 1);
  assert.equal(result.matches[0].path, 'Root.Main');
  assert.equal(result.matches[0].line, 2);
  assert.equal(result.matches[0].column, 1);
});

test('multi_edit applies a snippet edit and writes the model', () => {
  const file = path.join(tmp, 'edit-in.rbxm');
  const outFile = path.join(tmp, 'edit-out.rbxm');
  makePlace(file);

  const res = serve(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'multi_edit',
        arguments: {
          input: file,
          output: outFile,
          edits: [{ path: 'Root.Main', find: 'print("one")', replace: 'warn("one")' }],
        },
      },
    })}\n`,
  );
  const result = JSON.parse(jsonlMessages(res.stdout)[0].result.content[0].text);
  assert.equal(result.output, outFile);
  assert.equal(result.edits[0].occurrences, 1);
  assert.ok(fs.existsSync(outFile));

  const grep = spawnSync(process.execPath, [CLI, 'grep', outFile, 'warn', '--json'], { encoding: 'utf8', cwd: tmp });
  assert.equal(JSON.parse(grep.stdout).matchCount, 1);
});

test('multi_edit refuses a bad edit and writes nothing', () => {
  const file = path.join(tmp, 'edit-bad-in.rbxm');
  const outFile = path.join(tmp, 'edit-bad-out.rbxm');
  makePlace(file);

  const res = serve(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'multi_edit',
        arguments: {
          input: file,
          output: outFile,
          edits: [
            { path: 'Root.Main', find: 'print("one")', replace: 'warn("one")' },
            { path: 'Root.Mian', source: 'oops' },
          ],
        },
      },
    })}\n`,
  );
  const message = jsonlMessages(res.stdout)[0];
  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /Root\.Mian: no instance at that path/);
  assert.equal(fs.existsSync(outFile), false, 'a partially applied edit set must not be written');
});

test('diff_models reports a property change', () => {
  const before = path.join(tmp, 'diff-before.rbxm');
  const after = path.join(tmp, 'diff-after.rbxm');
  makePlace(before);
  makePlace(after);

  const edit = spawnSync(
    process.execPath,
    [CLI, 'edit', after, JSON.stringify([{ path: 'Root.Main', find: 'print("two")', replace: 'warn("two")' }])],
    { encoding: 'utf8', cwd: tmp },
  );
  assert.equal(edit.status, 0, edit.stderr);

  const res = serve(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'diff_models', arguments: { before, after } },
    })}\n`,
  );
  const result = JSON.parse(jsonlMessages(res.stdout)[0].result.content[0].text);
  assert.equal(result.summary.changed, 1);
  assert.equal(result.changed[0].path, 'Root.Main');
  assert.equal(result.changed[0].changes[0].property, 'Source');
});

// --- proxy ------------------------------------------------------------------

test('proxyStdio bridges bytes to a child process and back', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks = [];
  stdout.on('data', (c) => chunks.push(c));

  const done = proxyStdio(child, { stdin, stdout, stderr: new PassThrough() });
  stdin.write('{"jsonrpc":"2.0"}\n');
  stdin.end();
  const result = await done;

  assert.equal(result.error, null);
  assert.equal(Buffer.concat(chunks).toString('utf8'), '{"jsonrpc":"2.0"}\n');
  assert.equal(typeof result.code, 'number');
});

test('proxyStdio reports a child that cannot start', async () => {
  const child = spawn(path.join(tmp, 'definitely-not-here'), { stdio: ['pipe', 'pipe', 'pipe'] });
  const result = await proxyStdio(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  assert.match(result.error, /ENOENT/);
});

test('proxy without Studio explains itself instead of hanging', () => {
  const res = spawnSync(process.execPath, [CLI, 'proxy'], { encoding: 'utf8', cwd: tmp, timeout: 30000 });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /proxy needs the studio backend|Studio/i);
});
