// MCP server over stdio.
//
// Speaks JSON-RPC 2.0. Accepts both newline-delimited JSON (the MCP stdio
// convention) and LSP-style Content-Length framing, since clients differ.

import { toolList, callTool } from './tools.js';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_INFO = { name: 'studio-cli', version: '0.1.0' };

/** Serialize one JSON-RPC message in the framing the client is using. */
export function frameMessage(message, framing = 'jsonl') {
  const json = JSON.stringify(message);
  if (framing === 'lsp') {
    return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
  }
  return `${json}\n`;
}

export function createServer({ backend = 'auto', write } = {}) {
  // Replies must use the same framing the client speaks: a client that sends
  // Content-Length frames cannot parse a newline-delimited reply, and vice
  // versa. The transport sets this from the incoming request.
  let framing = 'jsonl';
  const emit = write ? write : (obj) => process.stdout.write(frameMessage(obj, framing));
  const respond = (id, result) => emit({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) => emit({ jsonrpc: '2.0', id, error: { code, message } });

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

  return { handle, respond, respondError, setFraming: (mode) => { if (mode) framing = mode; } };
}

/**
 * Read a stream, emitting one JSON message per frame.
 *
 * `onMessage(message, { framing })` — the framing is reported so the server can
 * reply in kind.
 */
export function attachStream(stream, onMessage) {
  /** @type {Buffer} */
  let buffer = Buffer.alloc(0);

  stream.on('data', (chunk) => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    buffer = buffer.length === 0 ? incoming : Buffer.concat([buffer, incoming]);

    for (;;) {
      // Headers are ASCII, so reading them as latin1 keeps character indices
      // equal to byte offsets — which matters because Content-Length is bytes.
      const head = buffer.subarray(0, 32).toString('latin1');

      if (head.startsWith('Content-Length:')) {
        const text = buffer.toString('latin1');
        const crlf = text.indexOf('\r\n\r\n');
        const lf = text.indexOf('\n\n');
        const headerEnd = crlf !== -1 && (lf === -1 || crlf <= lf) ? crlf : lf;
        if (headerEnd === -1) return;
        const sepLen = headerEnd === crlf ? 4 : 2;
        const match = text.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // A header block we cannot parse: drop it rather than spin forever.
          buffer = buffer.subarray(headerEnd + sepLen);
          continue;
        }
        const start = headerEnd + sepLen;
        const length = Number(match[1]);
        if (buffer.length - start < length) return; // wait for the rest
        const body = buffer.subarray(start, start + length).toString('utf8');
        buffer = buffer.subarray(start + length);
        try {
          onMessage(JSON.parse(body), { framing: 'lsp' });
        } catch {
          /* ignore malformed frame */
        }
        continue;
      }

      // Newline-delimited JSON.
      const idx = buffer.indexOf(0x0a);
      if (idx === -1) return;
      const line = buffer.subarray(0, idx).toString('utf8').trim();
      buffer = buffer.subarray(idx + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line), { framing: 'jsonl' });
      } catch {
        /* ignore malformed line */
      }
    }
  });
}

export function runStdioServer(options = {}) {
  const server = createServer(options);
  attachStream(process.stdin, (msg, meta) => {
    if (meta && meta.framing) server.setFraming(meta.framing);
    return server.handle(msg);
  });
  process.stderr.write(`studio-cli MCP server ready (backend=${options.backend || 'auto'})\n`);
  return server;
}
