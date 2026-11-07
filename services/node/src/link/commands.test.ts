import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type NodeLinkCommand, NodeLinkFailure } from '@farmslot/protocol';

import { NodeLinkCommands } from './commands.js';

const command = (expiresAt = Date.now() + 60_000): NodeLinkCommand => ({
  commandId: 'test-command',
  operation: 'fixture.write',
  target: { nodeId: 'fixture', resourceId: 'workspace' },
  authority: {
    requester: { principalId: 'operator', generation: 1 },
    executor: { principalId: 'node-fixture', generation: 0 },
    grantId: 'grant',
    approvalId: 'approval',
    approval: 'framework',
  },
  expiresAt,
  input: { value: 'one' },
});

test('durable admission deduplicates concurrent delivery and refuses changed arguments', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const broker = new NodeLinkCommands(root, {
    authorize: () => undefined,
    execute: async () => {
      calls++;
      await blocked;
      return { written: true };
    },
  });
  const input = command();
  const first = broker.execute(input);
  const second = broker.execute(input);
  await assert.rejects(broker.execute({ ...input, input: { value: 'two' } }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  release();
  assert.equal((await first).state, 'completed');
  assert.deepEqual(await second, await first);
  assert.equal(calls, 1);
  const reopened = new NodeLinkCommands(root, {
    authorize: () => undefined,
    execute: async () => assert.fail('A settled receipt must not execute again'),
  });
  assert.deepEqual(await reopened.execute(input), await first);
});

test('restart of admitted work is unknown and never replayed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const broker = new NodeLinkCommands(root, {
    authorize: () => undefined,
    execute: async () => blocked,
  });
  const input = command();
  const execution = broker.execute(input);
  await broker.admitted(input);
  const restarted = new NodeLinkCommands(root, {
    authorize: () => undefined,
    execute: async () => assert.fail('Unfinished admission must not replay'),
  });
  assert.equal((await restarted.execute(input)).state, 'unknown');
  release();
  await execution;
});

test('cancellation remains pending until the original executor confirms closeout', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let close!: () => void;
  const stopped = new Promise<void>((resolve) => (close = resolve));
  const broker = new NodeLinkCommands(root, {
    authorize: () => undefined,
    execute: async (_command, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await stopped;
      signal.throwIfAborted();
    },
  });
  const input = command();
  const execution = broker.execute(input);
  await broker.admitted(input);
  const cancellation = await broker.cancel(input);
  assert.equal(cancellation.state, 'cancel-requested');
  assert.equal(cancellation.closeoutConfirmed, false);
  close();
  const terminal = await execution;
  assert.equal(terminal.state, 'cancelled');
  assert.equal(terminal.closeoutConfirmed, true);
});

test('expired admissions and current authority failures never reach an executor', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const broker = new NodeLinkCommands(root, {
    authorize: () => undefined,
    execute: async () => assert.fail('Expired work must not execute'),
  });
  await assert.rejects(broker.execute(command(Date.now() - 1)), { code: 'COMMAND_EXPIRED' });
  const revoked = new NodeLinkCommands(root, {
    authorize: () => {
      throw new Error('revoked');
    },
    execute: async () => assert.fail('Revoked work must not execute'),
  });
  await assert.rejects(revoked.execute(command()), /revoked/);
});

test('admitted arguments cannot change through a caller-owned object', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let authorize!: () => void;
  const authorized = new Promise<void>((resolve) => (authorize = resolve));
  let actual: unknown;
  const broker = new NodeLinkCommands(root, {
    authorize: async () => authorized,
    execute: async (input) => {
      actual = input.input;
      return null;
    },
  });
  const input = command();
  const execution = broker.execute(input);
  input.input = { value: 'changed after submission' };
  authorize();
  await execution;
  assert.deepEqual(actual, { value: 'one' });
});

test('an unfinished durable outcome blocks a successor mutation key on the same resource', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const original = new NodeLinkCommands(root, {
    authorize: () => undefined,
    execute: async () => blocked,
  });
  const input = command();
  const executing = original.execute(input);
  await original.admitted(input);
  const restarted = new NodeLinkCommands(root, {
    authorize: () => undefined,
    execute: async () =>
      assert.fail('A successor must not act while the original outcome is unknown'),
  });
  try {
    await assert.rejects(restarted.execute({ ...input, commandId: 'successor-key' }), {
      code: 'RESOURCE_OUTCOME_UNKNOWN',
    });
  } finally {
    release();
    await executing;
  }
});

test('cancellation intent cannot admit a successor until confirmed closeout', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let close!: () => void;
  const stopped = new Promise<void>((resolve) => (close = resolve));
  const broker = new NodeLinkCommands(root, {
    authorize: () => undefined,
    execute: async (input, signal) => {
      if (input.commandId !== 'test-command') return null;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await stopped;
      signal.throwIfAborted();
    },
  });
  const input = command();
  const execution = broker.execute(input);
  await broker.admitted(input);
  await broker.cancel(input);
  try {
    await assert.rejects(broker.execute({ ...input, commandId: 'successor' }), {
      code: 'RESOURCE_BUSY',
    });
  } finally {
    close();
    await execution;
  }
  assert.equal(
    (await broker.execute({ ...input, commandId: 'successor' })).closeoutConfirmed,
    true,
  );
});

test('expired settled receipts reclaim capacity but their keys cannot acquire a new deadline', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let effects = 0;
  const owner = {
    authorize: () => undefined,
    execute: async () => {
      effects++;
      return null;
    },
  };
  const broker = new NodeLinkCommands(root, owner, 6);
  const expiry = Date.now() + 60_000;
  const first = { ...command(), commandId: `nl1:${expiry}:original`, expiresAt: expiry };
  await broker.execute(first);
  t.mock.timers.tick(10 * 60_000);
  for (const id of ['second', 'third', 'fourth', 'fifth'])
    await broker.execute({ ...command(), commandId: id });
  assert.equal(effects, 5);
  const restarted = new NodeLinkCommands(root, owner, 6);
  await assert.rejects(restarted.execute(first), { code: 'COMMAND_EXPIRED' });
  await assert.rejects(restarted.execute({ ...first, expiresAt: Date.now() + 60_000 }), {
    code: 'INVALID_PARAMS',
  });
  assert.equal(effects, 5);
});

test('post-admission refusal settles as failed without leaving an unknown resource', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-admission-refusal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let admissionChecks = 0;
  let effects = 0;
  const broker = new NodeLinkCommands(root, {
    authorize: () => {
      if (++admissionChecks === 2)
        throw new NodeLinkFailure('STALE_AUTHORITY', 'Lease changed during admission');
    },
    execute: async () => {
      effects++;
      return null;
    },
  });
  const first = command();
  const receipt = await broker.execute(first);
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.closeoutConfirmed, true);
  assert.equal(effects, 0);
  assert.equal((await broker.execute({ ...first, commandId: 'successor' })).state, 'completed');
  assert.equal(effects, 1);
});

test('boot recovery journals interrupted admission as failed unknown and releases only its fence', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-boot-unknown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let effects = 0;
  const executor = {
    authorize: () => undefined,
    execute: async () => {
      effects++;
      return null;
    },
  };
  const broker = new NodeLinkCommands(root, executor);
  const original = command();
  await broker.execute(original);
  const { createHash } = await import('node:crypto');
  const { readFile, writeFile } = await import('node:fs/promises');
  const file = path.join(
    root,
    createHash('sha256').update(original.commandId).digest('hex') + '.json',
  );
  const interrupted = {
    ...JSON.parse(await readFile(file, 'utf8')),
    state: 'running',
    closeoutConfirmed: false,
  };
  delete interrupted.result;
  delete interrupted.settledAt;
  await writeFile(file, JSON.stringify(interrupted));
  await writeFile(
    path.join(root, 'pending.json'),
    JSON.stringify([
      [original.commandId, JSON.stringify([original.target.nodeId, original.target.resourceId])],
    ]),
  );
  const restarted = new NodeLinkCommands(root, executor);
  await restarted.recoverInterrupted();
  const failed = await restarted.receipt(original);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error?.code, 'OUTCOME_UNKNOWN');
  assert.equal(failed.closeoutConfirmed, false);
  assert.equal((await restarted.execute(original)).error?.code, 'OUTCOME_UNKNOWN');
  assert.equal(effects, 1, 'Reading the original effect never retries it');
  assert.equal(
    (await restarted.execute({ ...original, commandId: 'domain-replay' })).state,
    'completed',
  );
  assert.equal(effects, 2);
});

test('restart between admission publication and index publication still fails unknown and releases the fence', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-index-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executor = { authorize: () => undefined, execute: async () => null };
  const first = new NodeLinkCommands(root, executor);
  const input = command();
  await first.execute(input);
  const { createHash } = await import('node:crypto');
  const { readFile, writeFile, unlink } = await import('node:fs/promises');
  const file = path.join(
    root,
    createHash('sha256').update(input.commandId).digest('hex') + '.json',
  );
  const value = {
    ...JSON.parse(await readFile(file, 'utf8')),
    state: 'admitted',
    closeoutConfirmed: false,
  };
  await writeFile(file, JSON.stringify(value));
  await unlink(path.join(root, 'pending.json'));
  const restarted = new NodeLinkCommands(root, executor);
  await restarted.recoverInterrupted();
  assert.equal((await restarted.receipt(input)).error?.code, 'OUTCOME_UNKNOWN');
  assert.equal(
    (await restarted.execute({ ...input, commandId: 'explicit-replay' })).state,
    'completed',
  );
});
