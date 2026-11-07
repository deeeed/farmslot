import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { nativeRunnerDefinitions } from './registry.js';

test('cursor review sandbox includes the persist lock directory', () => {
  const roots = nativeRunnerDefinitions.cursor.reviewRuntimeRoots?.({ HOME: '/Users/x' }) ?? [];
  assert.ok(roots.some((root) => root.endsWith('/.cursor')));
  assert.ok(roots.some((root) => root.includes('Application Support/Cursor')));
  if (typeof process.getuid === 'function') {
    assert.ok(roots.includes(join('/tmp', `cursor-agent-persist-${process.getuid()}`)));
  }
});

test('claude review sandbox includes the tool-runner scratch directory', () => {
  const roots = nativeRunnerDefinitions.claude.reviewRuntimeRoots?.({ HOME: '/Users/x' }) ?? [];
  assert.ok(roots.some((root) => root.endsWith('/.claude')));
  if (typeof process.getuid === 'function') {
    assert.ok(roots.includes(join('/tmp', `claude-${process.getuid()}`)));
  }
});

test('pi can enter the shared read-only host sandbox', async () => {
  const { hostReviewSandboxAvailable } = await import('./review-sandbox.js');
  assert.equal(nativeRunnerDefinitions.pi.supportsReadOnlyWorkspace, hostReviewSandboxAvailable());
});

test('every managed runner declares read-only review support and writable runtime roots', async () => {
  const { hostReviewSandboxAvailable } = await import('./review-sandbox.js');
  for (const [runner, definition] of Object.entries(nativeRunnerDefinitions)) {
    if (!definition.supportsWorkers) continue;
    assert.equal(
      definition.supportsReadOnlyWorkspace,
      runner === 'codex' || hostReviewSandboxAvailable(),
      `${runner} read-only review capability`,
    );
    assert(
      (definition.reviewRuntimeRoots?.({ HOME: '/Users/review' }) ?? []).length > 0,
      `${runner} review runtime roots`,
    );
  }
});

test('pi review roots honor its selected profile instead of the ambient account', () => {
  assert.deepEqual(
    nativeRunnerDefinitions.pi.reviewRuntimeRoots?.({
      HOME: '/Users/review',
      PI_CODING_AGENT_DIR: '/profiles/pi',
    }),
    ['/profiles/pi'],
  );
});

test('opencode review roots honor XDG data, cache, state and config locations', () => {
  assert.deepEqual(
    nativeRunnerDefinitions.opencode.reviewRuntimeRoots?.({
      HOME: '/Users/review',
      XDG_DATA_HOME: '/profiles/data',
      XDG_CACHE_HOME: '/profiles/cache',
      XDG_STATE_HOME: '/profiles/state',
      XDG_CONFIG_HOME: '/profiles/config',
    }),
    [
      '/profiles/data/opencode',
      '/profiles/cache/opencode',
      '/profiles/state/opencode',
      '/profiles/config/opencode',
    ],
  );
});

test('registered Claude Code ACP retains native approvals and workspace policy', () => {
  const definition = nativeRunnerDefinitions['claude-acp'];
  assert(definition);
  assert.equal(definition.supportsWorkers, true);
  assert.deepEqual(definition.adapter.capabilities.modes, ['default', 'plan']);
  assert.deepEqual(definition.adapter.capabilities.approvalModes, ['ask', 'bypass']);
  assert.equal(
    definition.account.standardDirectory({ HOME: '/home/account' }),
    nativeRunnerDefinitions.claude.account.standardDirectory({ HOME: '/home/account' }),
  );
});
