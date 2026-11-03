import { test } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { startServer } from './support/deepseek-mock-server.mjs';

const script = fileURLToPath(new URL('./support/deepseek-mock-server.mjs', import.meta.url));

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(
    `CLI ${signal} exits cleanly with an active request and releases its port`,
    {
      timeout: 8000,
      skip:
        process.platform === 'win32'
          ? 'POSIX signal delivery; use programmatic cleanup on Windows'
          : false,
    },
    async () => {
      const child = spawn(process.execPath, [script, '--port=0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exited = once(child, 'exit');
      let output = '';
      let errors = '';
      child.stderr.on('data', (chunk) => {
        errors += chunk;
      });
      let outgoing;
      try {
        const port = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', () => reject(new Error(`Exited before readiness: ${errors}`)));
          child.stdout.on('data', (chunk) => {
            output += chunk;
            const match = output.match(/running on http:\/\/localhost:(\d+)/);
            if (match) resolve(Number(match[1]));
          });
        });
        ok(port > 0, 'CLI readiness must report the allocated ephemeral port');
        // 100 Continue confirms the server owns an active HTTP connection. Leave the
        // body unfinished, so shutdown must not wait for the normal request timeout.
        outgoing = request({
          hostname: 'localhost',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { Expect: '100-continue', 'Content-Length': '100', 'X-Mock-Mode': 'timeout' },
        });
        outgoing.on('error', () => {});
        const continued = once(outgoing, 'continue');
        outgoing.flushHeaders();
        await continued;
        child.kill(signal);
        deepStrictEqual(await once(child, 'exit', { signal: AbortSignal.timeout(2000) }), [
          0,
          null,
        ]);
        ok(output.includes('Server closed'));
        strictEqual(errors, '');
        const replacement = startServer(port);
        try {
          await once(replacement, 'listening');
        } finally {
          await new Promise((resolve) => replacement.close(resolve));
        }
      } finally {
        outgoing?.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    },
  );
}
