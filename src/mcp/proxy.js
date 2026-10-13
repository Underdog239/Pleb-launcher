// Stdio bridge to another MCP server process.
//
// Roblox Studio ships its own MCP server (execute_luau, multi_edit, the
// playtest subagent, asset tools), which is the only way to reach real engine
// fidelity. Rather than reimplement it, this hands the whole protocol over:
// the MCP client on the far side talks JSON-RPC to Studio and this process is
// a byte pipe, so nothing is lost in translation — no tool list to keep in
// sync, no framing to re-encode.

/**
 * Bridge the current process's stdio to a spawned MCP server.
 *
 * @param {import('node:child_process').ChildProcess} child a process with piped stdin/stdout
 * @param {{stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream}} [streams]
 * @returns {Promise<{code: number|null, signal: string|null, error: string|null}>}
 */
export function proxyStdio(child, streams = {}) {
  const { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = streams;
  const cleanups = [];

  const pipe = (src, dst, options) => {
    if (!src || !dst) return;
    src.pipe(dst, options);
    cleanups.push(() => src.unpipe(dst));
  };

  if (child.stdin) {
    pipe(stdin, child.stdin);
    // The client closing its side of the pipe is a normal shutdown: propagate
    // it so the child can flush and exit instead of hanging forever.
    const onEnd = () => {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
    };
    stdin.once?.('end', onEnd);
    cleanups.push(() => stdin.removeListener?.('end', onEnd));
  }

  pipe(child.stdout, stdout);
  // Studio's stderr is inherited in the default spawn, so this is often absent.
  pipe(child.stderr, stderr, { end: false });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      resolve(result);
    };
    child.on('error', (err) => finish({ code: null, signal: null, error: err.message }));
    child.on('close', (code, signal) => finish({ code: code ?? null, signal: signal ?? null, error: null }));
  });
}
