// MCP server over stdio.
//
// Speaks JSON-RPC 2.0. Accepts both newline-delimited JSON (the MCP stdio
// convention) and LSP-style Content-Length framing, since clients differ.

import { toolList, callTool } from './tools.js';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_INFO = { name: 'studio-cli', version: '0.1.0' };

export function createServer({ backend = 'auto', write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`) } = {}) {
  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    const id = msg.id;
    const isNotification = id === undefined || id === null;
    try {
      switch (msg.method) {
        case 'initialize':
          return respond(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          });
        case 'notifications/initialized':
        case 'initialized':
          return undefined;
        case 'ping':
          return respond(id, {});
        case 'tools/list':
          return respond(id, { tools: toolList() });
        case 'tools/call': {
          const name = msg.params?.name;
          const args = msg.params?.arguments || {};
          try {
            const result = await callTool(name, args, { backend });
            return respond(id, {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            });
          } catch (err) {
            return respond(id, {
              content: [{ type: 'text', text: String(err?.message || err) }],
              isError: true,
            });
          }
        }
        case 'resources/list':
          return respond(id, { resources: [] });
        case 'prompts/list':
          return respond(id, { prompts: [] });
        default:
          if (isNotification) return undefined;
          return respondError(id, -32601, `method not found: ${msg.method}`);
      }
    } catch (err) {
      if (!isNotification) respondError(id, -32603, String(err?.message || err));
      return undefined;
    }
  }

  return { handle, respond, respondError };
}

/** Read a stream, emitting one JSON message per frame. */
export function attachStream(stream, onMessage) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      // LSP-style framing.
      if (buffer.startsWith('Content-Length:')) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const match = buffer.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
        if (!match) return;
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        const body = buffer.slice(start, start + length);
        buffer = buffer.slice(start + length);
        try {
          onMessage(JSON.parse(body));
        } catch {
          /* ignore malformed frame */
        }
        continue;
      }
      // Newline-delimited JSON.
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        /* ignore malformed line */
      }
    }
  });
}

export function runStdioServer(options = {}) {
  const server = createServer(options);
  attachStream(process.stdin, (msg) => server.handle(msg));
  process.stderr.write(`studio-cli MCP server ready (backend=${options.backend || 'auto'})\n`);
  return server;
}
