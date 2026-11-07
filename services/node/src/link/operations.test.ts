import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NODE_LINK_LIMITS, type NodeLinkCommand } from '@farmslot/protocol';

import { parseNodeLinkOperation } from './operations.js';

const command = (operation: string, input: unknown): NodeLinkCommand => ({
  commandId: 'typed-command',
  operation,
  input,
  target: { nodeId: 'fixture', resourceId: 'workspace' },
  authority: {
    requester: { principalId: 'operator', generation: 1 },
    executor: { principalId: 'node', generation: 0 },
    grantId: 'grant',
    approvalId: 'approval',
    approval: 'framework',
  },
  expiresAt: Date.now() + 60_000,
});

test('typed process accepts exact argv and refuses shell-string and widening fields', () => {
  const input = {
    argv: ['/usr/bin/true'],
    cwd: '/workspace',
    timeoutMs: 1000,
    maxOutputBytes: 1024,
  };
  assert.deepEqual(parseNodeLinkOperation(command('process.run', input)).input, input);
  for (const invalid of [
    { ...input, cmd: 'unrestricted shell' },
    { ...input, argv: [] },
    { ...input, timeoutMs: Infinity },
    { ...input, model: 'unrelated' },
  ])
    assert.throws(() => parseNodeLinkOperation(command('process.run', invalid)), {
      code: 'INVALID_PARAMS',
    });
});

test('file input validates traversal, fields, ranges and encoded chunk limits before admission', () => {
  for (const relative of ['../escape', '/escape', 'a/../../escape', '.git/config', 'a\\escape'])
    assert.throws(
      () =>
        parseNodeLinkOperation(command('file.inspect', { root: '/workspace', relPath: relative })),
      { code: 'INVALID_PARAMS' },
    );
  assert.throws(
    () =>
      parseNodeLinkOperation(
        command('file.read-range', { root: '/workspace', relPath: 'file', offset: -1, length: 10 }),
      ),
    { code: 'INVALID_PARAMS' },
  );
  assert.throws(
    () =>
      parseNodeLinkOperation(
        command('file.write-range', {
          root: '/workspace',
          relPath: 'file',
          offset: 0,
          content: Buffer.alloc(NODE_LINK_LIMITS.chunkBytes + 1).toString('base64'),
        }),
      ),
    { code: 'INVALID_PARAMS' },
  );
  assert.throws(
    () =>
      parseNodeLinkOperation(
        command('file.write', {
          root: '/workspace',
          relPath: 'file',
          content: 'ok',
          ownerPrincipalId: 'other',
        }),
      ),
    { code: 'INVALID_PARAMS' },
  );
});

test('PTY process uses bounded dimensions and cannot widen its admitted argv policy', () => {
  const input = {
    argv: ['/usr/bin/tmux', 'attach-session', '-t', 'fixture'],
    cwd: '/workspace',
    timeoutMs: 60_000,
    maxOutputBytes: 1024,
    terminal: { cols: 120, rows: 40 },
  };
  assert.deepEqual(parseNodeLinkOperation(command('process.run', input)).input, input);
  for (const terminal of [
    { cols: 0, rows: 40 },
    { cols: 120, rows: 1001 },
    { cols: 120, rows: 40, command: 'other' },
  ])
    assert.throws(() => parseNodeLinkOperation(command('process.run', { ...input, terminal })), {
      code: 'INVALID_PARAMS',
    });
});
