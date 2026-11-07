import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { NodeLinkCommand, NodeLinkGrant } from '@farmslot/protocol';

import { NodeLinkAgent } from './agent.js';

const principal = { principalId: 'node-fixture', generation: 0 };
function grant(root: string, id: string): NodeLinkGrant {
  return {
    target: { nodeId: 'fixture', resourceId: 'workspace' },
    root,
    authority: {
      requester: { principalId: 'operator', generation: 1 },
      executor: principal,
      grantId: id,
      approvalId: id,
      approval: 'framework',
    },
    expiresAt: Date.now() + 60_000,
    operations: ['file.write'],
  };
}

test('more than thirty-two definitive pre-admission refusals do not leak grants', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-refusal-grants-')));
  const agent = new NodeLinkAgent(
    path.join(root, 'receipts'),
    'fixture',
    principal,
    () => true,
    () => true,
  );
  t.after(async () => {
    await agent.retire();
    await rm(root, { recursive: true, force: true });
  });
  for (let n = 0; n < 40; n++) {
    const policy = grant(root, `grant-${n}`);
    await agent.handle('node.link.authorize', policy);
    const command: NodeLinkCommand = {
      commandId: `command-${n}`,
      operation: 'file.write',
      target: policy.target,
      authority: policy.authority,
      expiresAt: Date.now() - 1,
      input: { root, relPath: 'never-written', content: 'no' },
    };
    await assert.rejects(agent.handle('node.link.command', command), { code: 'COMMAND_EXPIRED' });
  }
});

test('settled process streams with lost release cannot permanently exhaust connection capacity', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-settled-streams-')));
  const agent = new NodeLinkAgent(
    path.join(root, 'receipts'),
    'fixture',
    principal,
    () => true,
    () => true,
  );
  t.after(async () => {
    await agent.retire();
    await rm(root, { recursive: true, force: true });
  });
  for (let n = 0; n < 40; n++) {
    const process = {
      argv: [globalThis.process.execPath, '-e', 'process.stdout.write("x")'],
      cwd: root,
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    };
    const policy: NodeLinkGrant = {
      ...grant(root, `grant-${n}`),
      operations: ['process.run'],
      process,
    };
    await agent.handle('node.link.authorize', policy);
    const result = await agent.handle('node.link.command', {
      commandId: `process-${n}`,
      operation: 'process.run',
      target: policy.target,
      authority: policy.authority,
      expiresAt: policy.expiresAt,
      input: process,
    });
    assert(
      result && typeof result === 'object' && 'state' in result && result.state === 'completed',
    );
  }
});
