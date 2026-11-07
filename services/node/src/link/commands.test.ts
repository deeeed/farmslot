import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { NodeLinkCommand } from '@farmslot/protocol';

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
