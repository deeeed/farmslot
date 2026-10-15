// Manual production-RPC proof. No worker, physical slot or real tmux server.
// TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx --experimental-test-module-mocks <this-file>
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'manual-backlog-rpc-'));
const output = process.env.FARMSLOT_PROOF_OUTPUT_DIR;
assert.ok(output, 'Set FARMSLOT_PROOF_OUTPUT_DIR to retain the proof receipt');
Object.assign(process.env, {
  FARMSLOT_ROOT: source,
  FARMSLOT_HOME: path.join(temporary, 'home'),
  FARMSLOT_PROJECTS_DIR: path.join(source, 'projects'),
  FARMSLOT_POOL_DIR: path.join(temporary, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(temporary, 'runs'),
  FARMSLOT_BACKLOG_FILE: path.join(temporary, 'backlog.json'),
  FARMSLOT_DISPATCH_QUEUE_FILE: path.join(temporary, 'queue.json'),
  FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  NODE_TEST_CONTEXT: '1',
});
await import('../../../services/gateway/src/runtime/mock-pty.test-support.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } =
  await import('../../../services/gateway/src/security/auth.js');
const { createWebSocketServer } = await import('../../../services/gateway/src/server.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const auth = createGatewayAuthRuntime();
initializeGatewayIdentity(auth, { host: '127.0.0.1' });
const server = createServer();
const wss = createWebSocketServer(server, auth);
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    credential: null,
    timeout: 10_000,
  });
  const before = await client.call<{ totalCount: number }>('run.list');
  const refusals: Array<{ method: string; ticketOrPr: string; message: string }> = [];
  for (const method of ['run.create', 'run.createNative']) {
    for (const ticketOrPr of ['MANUAL-000146', 'manual-000146']) {
      await assert.rejects(
        client.call(method, {
          project: 'farmslot-farm',
          flowType: 'dev',
          mode: 'interactive',
          ticketOrPr,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /manual backlog refs/);
          assert.match(error.message, /farmslot backlog enqueue MANUAL-000146/);
          refusals.push({ method, ticketOrPr, message: error.message });
          return true;
        },
      );
    }
  }
  const after = await client.call<{ totalCount: number }>('run.list');
  assert.equal(before.totalCount, 0);
  assert.equal(after.totalCount, 0, 'refusal creates no placeholder run or worker');
  mkdirSync(output, { recursive: true });
  writeFileSync(
    path.join(output, 'rpc-proof.json'),
    JSON.stringify({ pass: true, refusals, runsBefore: 0, runsAfter: 0 }, null, 2) + '\n',
  );
  console.log('Manual backlog admission RPC proof PASS');
} finally {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(temporary, { recursive: true, force: true });
}
