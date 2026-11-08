import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import {
  isNodeLinkCommand,
  type NodeLinkAuthority,
  NodeLinkFailure,
  PROTOCOL_VERSION,
} from '@farmslot/protocol';

import { NodeLinkAgent } from '../../../node/src/link/agent.js';

const suiteRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-rpc-suite-')));
const previousPool = process.env.FARMSLOT_POOL_DIR;
const previousHome = process.env.FARMSLOT_HOME;
process.env.FARMSLOT_HOME = suiteRoot;
process.env.FARMSLOT_POOL_DIR = path.join(suiteRoot, 'pool');
await mkdir(process.env.FARMSLOT_POOL_DIR);
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_TEST_STATUS_FILE = path.join(suiteRoot, 'status.json');
process.env.FARMSLOT_RUNS_DIR = path.join(suiteRoot, 'runs');
process.env.FARMSLOT_PROJECTS_DIR = path.join(suiteRoot, 'projects');
after(async () => {
  if (previousPool === undefined) delete process.env.FARMSLOT_POOL_DIR;
  else process.env.FARMSLOT_POOL_DIR = previousPool;
  if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
  else process.env.FARMSLOT_HOME = previousHome;
  await rm(suiteRoot, { recursive: true, force: true });
});
const { registerNode, unregisterByWs } = await import('./machine-registry.js');
const { acceptNodeLinkStream, invokeNodeLink } = await import('./node-link.js');
const { handleNodeResponse } = await import('./node-rpc.js');

async function linkedNode(t: TestContext, root: string, machine: string) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const accepted = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
  const nodeSocket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const gatewaySocket = await accepted;
  await new Promise<void>((resolve) => nodeSocket.once('open', resolve));
  await writeFile(
    path.join(suiteRoot, 'pool', `${machine}.json`),
    JSON.stringify({ machine, env: { FARMSLOT_NODE_LINK_ENABLED: '1' } }),
  );
  const principal = { principalId: 'node-fixture', generation: 0 };
  const agent = new NodeLinkAgent(
    path.join(root, 'receipts'),
    machine,
    principal,
    () => nodeSocket.readyState === WebSocket.OPEN,
    (frame) => {
      nodeSocket.send(JSON.stringify(frame));
      return true;
    },
  );
  t.after(async () => {
    await agent.retire();
    unregisterByWs(gatewaySocket);
    nodeSocket.terminate();
    gatewaySocket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const calls: Array<{ method: string; params: unknown }> = [];
  nodeSocket.on('message', async (raw) => {
    const frame = JSON.parse(raw.toString());
    calls.push({ method: frame.method, params: frame.params });
    try {
      const payload = await agent.handle(frame.method, frame.params);
      nodeSocket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }));
    } catch (error) {
      nodeSocket.send(
        JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: false,
          error: {
            code: error instanceof NodeLinkFailure ? error.code : 'EXECUTION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  });
  gatewaySocket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'res')
      handleNodeResponse(
        frame.id,
        frame.ok,
        frame.payload,
        frame.error?.message,
        frame.error?.code,
        gatewaySocket,
      );
    else if (frame.event === 'node.link.stream') acceptNodeLinkStream(gatewaySocket, frame.payload);
  });
  registerNode(
    machine,
    process.pid,
    gatewaySocket,
    PROTOCOL_VERSION,
    PROTOCOL_VERSION,
    undefined,
    undefined,
    undefined,
    true,
    undefined,
    () => true,
    true,
    true,
    {
      node: { protocolVersion: PROTOCOL_VERSION },
      nodeLink: agent.capabilities,
      nodePrincipal: principal,
    },
  );
  return { agent, principal, calls };
}

for (const size of [1024, 180000]) {
  test(
    `task libraries retain node-link grants and ${size}-byte output without repeating execution`,
    { timeout: 5000 },
    async (t) => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-task-runtime-')));
      t.after(() => rm(root, { recursive: true, force: true }));
      const cli = path.join(root, 'packages/cli');
      for (const directory of ['bin', 'src/commands', 'src/onboarding'])
        await mkdir(path.join(cli, directory), { recursive: true });
      await symlink(
        path.resolve(import.meta.dirname, '../../../../node_modules'),
        path.join(root, 'node_modules'),
      );
      await writeFile(path.join(cli, 'package.json'), '{"type":"module"}');
      await writeFile(path.join(cli, 'bin/farmslot.mjs'), '');
      await writeFile(path.join(cli, 'tsconfig.json'), '{}');
      await copyFile(
        path.resolve(import.meta.dirname, '../../../../packages/cli/src/envelope.ts'),
        path.join(cli, 'src/envelope.ts'),
      );
      await writeFile(
        path.join(cli, 'src/onboarding/env-file.ts'),
        'export function loadCheckoutEnv() {}',
      );
      await writeFile(
        path.join(cli, 'src/onboarding/workspace.ts'),
        'export const repoRoot = "/fixture"; export function bootstrapFarmslotHome() {}',
      );
      const marker = path.join(root, 'executed');
      await writeFile(
        path.join(cli, 'src/commands/hosted-task-init.ts'),
        `
    import fs from 'node:fs';
    export async function runHostedTaskInit() {
      fs.appendFileSync(${JSON.stringify(marker)}, 'once\\n');
      return { pid: process.pid, payload: 'x'.repeat(${size}) };
    }
  `,
      );
      const machine = 'node-link-task-runtime-fixture';
      const { agent, principal, calls } = await linkedNode(t, root, machine);
      const authority: NodeLinkAuthority = {
        requester: { principalId: 'operator', generation: 1 },
        executor: principal,
        grantId: 'task-policy',
        approvalId: 'fixture-approval',
        approval: 'framework',
        lease: { runId: 'run', contextId: 'workspace', leaseId: 'slot:4', generation: '4' },
      };
      const request = {
        operation: 'task.runtime' as const,
        input: {
          action: 'init' as const,
          taskPath: path.join(root, 'task-init.json'),
          supportDir: root,
          env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
        },
      };
      const invocation = {
        commandId: `retained-task-command-${size}`,
        target: { nodeId: machine, resourceId: 'fixture-task' },
        authority,
        timeoutMs: 4000,
        assertCurrent() {},
      };
      const receipt = await invokeNodeLink(request, invocation);
      assert.equal(receipt.state, 'completed');
      assert.equal(receipt.closeoutConfirmed, true);
      const result = receipt.result;
      assert(
        result &&
          typeof result === 'object' &&
          'stdout' in result &&
          typeof result.stdout === 'string',
      );
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.data.pid, process.pid, 'task runs inside its execution node');
      assert.equal(parsed.data.payload, 'x'.repeat(size));
      if (size === 1024) assert.deepEqual(await invokeNodeLink(request, invocation), receipt);
      else await assert.rejects(invokeNodeLink(request, invocation), { code: 'RESULT_EXPIRED' });
      assert.equal(await readFile(marker, 'utf8'), 'once\n');
      const command = calls.find((entry) => entry.method === 'node.link.command')?.params;
      assert(isNodeLinkCommand(command));
      await agent.handle('node.link.authorize', {
        authority,
        target: invocation.target,
        expiresAt: command.expiresAt,
        operations: ['task.runtime'],
        task: request.input,
      });
      await assert.rejects(
        agent.handle('node.link.command', {
          ...command,
          input: { ...request.input, taskPath: '/other/task' },
        }),
        { code: 'POLICY_REFUSED' },
      );
      assert.equal(await readFile(marker, 'utf8'), 'once\n');
    },
  );
}
