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

const IDENTITY = {
  epoch: 3,
  currentRunId: null,
  cleanupRunId: null,
  handoffRunId: null,
  branch: 'main',
  headSha: 'abc123',
  dirtyFingerprint: 'clean',
  recoveryId: 'rec-1',
};

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

async function runRecover(
  slots: unknown[],
): Promise<{ refreshParams: unknown[]; run: Awaited<ReturnType<typeof spawnCli>> }> {
  const refreshParams: unknown[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(String(data)) as { id: string; method: string; params?: unknown };
      let payload: unknown = {};
      if (request.method === 'fleet.status') payload = { fleet: { slots } };
      if (request.method === 'slot.refresh') {
        refreshParams.push(request.params);
        payload = { refreshed: true };
      }
      socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const home = mkdtempSync(path.join(os.tmpdir(), 'farmslot-slot-recover-'));
  try {
    const run = await spawnCli(
      [
        '--url',
        `ws://127.0.0.1:${address.port}`,
        '--timeout',
        '3000',
        'slot',
        'refresh',
        'macpro-mm-1',
        '--recover',
      ],
      home,
    );
    return { refreshParams, run };
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test('slot refresh --recover sends release and the fleet workspace identity', async () => {
  const { refreshParams, run } = await runRecover([
    {
      slot: 'macpro-mm-1',
      workspace: { ...IDENTITY, observedAt: 'now', dirtyCount: 0, extra: 'dropped' },
    },
  ]);
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.deepEqual(refreshParams, [
    { slotId: 'macpro-mm-1', release: true, expectedWorkspace: IDENTITY },
  ]);
});

test('slot refresh --recover refuses a slot with no workspace identity', async () => {
  const { refreshParams, run } = await runRecover([{ slot: 'macpro-mm-1' }]);
  assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /has no workspace identity/);
  assert.deepEqual(refreshParams, []);
});
