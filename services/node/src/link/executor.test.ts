import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import type { NodeLinkAuthority, NodeLinkCommand, NodeLinkGrant } from '@farmslot/protocol';

import { NodeLinkExecutor } from './executor.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-executor-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authority: NodeLinkAuthority = {
    requester: { principalId: 'operator', generation: 1 },
    executor: { principalId: 'node-fixture', generation: 0 },
    grantId: 'grant',
    approvalId: 'approval',
    approval: 'framework',
    lease: { runId: 'run', contextId: 'worker', leaseId: 'lease', generation: 'generation' },
  };
  const grant: NodeLinkGrant = {
    target: { nodeId: 'fixture', resourceId: 'workspace' },
    authority,
    root,
    expiresAt: Date.now() + 60_000,
    operations: ['file.write', 'file.read'],
  };
  let current = true;
  const executor = new NodeLinkExecutor(
    path.join(root, 'receipts'),
    'fixture',
    authority.executor,
    () => current,
  );
  const command: NodeLinkCommand = {
    commandId: 'write',
    operation: 'file.write',
    target: grant.target,
    authority,
    expiresAt: grant.expiresAt,
    input: { root, relPath: 'file', content: 'one', expectedHash: null },
  };
  return {
    root,
    executor,
    command,
    grant,
    retire: () => {
      current = false;
    },
  };
}

test('real file write is admitted once and retained across a same-authority query', async (t) => {
  const f = await fixture(t);
  f.executor.bind(f.grant);
  assert.equal((await f.executor.commands.execute(f.command)).state, 'completed');
  assert.equal(await readFile(path.join(f.root, 'file'), 'utf8'), 'one');
  // The create-only precondition would fail if this repeated the effect.
  assert.equal((await f.executor.commands.execute(f.command)).state, 'completed');
  assert.equal((await f.executor.commands.receipt(f.command)).closeoutConfirmed, true);
});

test('replaced grant/lease and retired socket refuse before file effects or outcome reads', async (t) => {
  const f = await fixture(t);
  f.executor.bind(f.grant);
  f.executor.bind({
    ...f.grant,
    authority: {
      ...f.grant.authority,
      grantId: 'replacement',
      lease: { ...f.grant.authority.lease!, leaseId: 'successor' },
    },
  });
  await assert.rejects(f.executor.commands.execute(f.command), { code: 'STALE_AUTHORITY' });
  await assert.rejects(readFile(path.join(f.root, 'file')), { code: 'ENOENT' });
  f.executor.bind(f.grant);
  await f.executor.commands.execute(f.command);
  f.retire();
  await assert.rejects(f.executor.commands.receipt(f.command), { code: 'STALE_SOCKET' });
});

test('admitted root cannot be substituted and symlinked parents cannot escape it', async (t) => {
  const f = await fixture(t);
  f.executor.bind(f.grant);
  await assert.rejects(
    f.executor.commands.execute({
      ...f.command,
      input: { root: '/', relPath: 'unowned', content: 'no' },
    }),
    { code: 'POLICY_REFUSED' },
  );
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'protected'), 'original');
  await symlink(outside, path.join(f.root, 'link'));
  const receipt = await f.executor.commands.execute({
    ...f.command,
    input: { root: f.root, relPath: 'link/protected', content: 'no' },
  });
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.error?.code, 'POLICY_REFUSED');
  assert.equal(await readFile(path.join(outside, 'protected'), 'utf8'), 'original');
});

test(
  'replacing a lease fences new effects while its original command can still confirm cancellation',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const input = {
      argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
      cwd: f.root,
      timeoutMs: 3000,
      maxOutputBytes: 1024,
    };
    const grant: NodeLinkGrant = { ...f.grant, operations: ['process.run'], process: input };
    const command: NodeLinkCommand = { ...f.command, operation: 'process.run', input };
    f.executor.bind(grant);
    const executing = f.executor.commands.execute(command);
    await f.executor.commands.admitted(command);
    f.executor.bind({
      ...grant,
      authority: {
        ...grant.authority,
        grantId: 'successor',
        lease: { ...grant.authority.lease!, leaseId: 'next-lease' },
      },
    });
    try {
      await assert.rejects(
        f.executor.commands.cancel({ ...command, input: { ...input, argv: ['/usr/bin/false'] } }),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
      await f.executor.commands.cancel(command);
      const receipt = await executing;
      assert.equal(receipt.state, 'cancelled');
      assert.equal(receipt.closeoutConfirmed, true);
      await assert.rejects(
        f.executor.commands.execute({ ...command, commandId: 'old-owner-new-command' }),
        { code: 'STALE_AUTHORITY' },
      );
    } finally {
      await f.executor.retire();
      await executing;
    }
  },
);
