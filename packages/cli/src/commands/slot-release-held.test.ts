import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(packageDir, '../..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const entry = path.join(packageDir, 'src', 'entry.ts');

const HELD =
  'Slot macpro-mm-1 stays held: Prepare scope cleanup failed: preflight group 4242 survived SIGKILL';

function spawnCli(
  args: string[],
  home: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [entry, ...args], {
      cwd: packageDir,
      env: { ...process.env, FARMSLOT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI fixture timed out'));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test('slot release and recycle report a slot the gateway left held and exit non-zero', async () => {
  // The gateway rejects a release whose preflight group survived: the slot
  // stays held, so neither command may print completion or exit 0.
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(String(data)) as { id: string; method: string };
      if (request.method === 'auth.connect') {
        socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: {} }));
        return;
      }
      socket.send(
        JSON.stringify({
          type: 'res',
          id: request.id,
          ok: false,
          error: { code: 'METHOD_ERROR', message: HELD },
        }),
      );
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}`;
  const home = mkdtempSync(path.join(os.tmpdir(), 'farmslot-slot-release-held-'));
  try {
    for (const verb of ['release', 'recycle']) {
      const run = await spawnCli(
        ['--url', url, '--timeout', '3000', 'slot', verb, 'macpro-mm-1'],
        home,
      );
      // Piped stdout puts the CLI in machine mode: one error envelope, exit 1.
      assert.equal(run.status, 1, `${verb}: ${run.stdout}${run.stderr}`);
      const envelope = JSON.parse(run.stdout) as { status: string; error: { message: string } };
      assert.equal(envelope.status, 'error');
      assert.equal(envelope.error.message, HELD);
      assert.doesNotMatch(run.stdout, /complete for/i);
    }
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
