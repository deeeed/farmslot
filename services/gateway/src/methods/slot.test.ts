import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import {
  buildDevServerPortCleanup,
  buildKillRoleWindowCommand,
  buildPreparePlaceholderCommand,
  buildPrepareWindowName,
  buildPrepareWrappedCommand,
  getPrepareDepsTimeoutMs,
  getPreparePreflightTimeoutMs,
  getPrepareSentinelPollTimeoutMs,
  shouldEmitPreparePollWarning,
  shouldPreservePrepareWindowOnSuccess,
  slotRefreshBlockedReason,
} from './slot.js';

function makeSlot(overrides: Partial<SlotStatus> & { slot: string }): SlotStatus {
  return {
    machine: 'mock',
    platform: 'darwin',
    project: 'demo',
    health: { device: '-', devserver: '-', cdp: '-' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    ...overrides,
  } as SlotStatus;
}

test('buildKillRoleWindowCommand preserves tmux session when killing last role window', () => {
  const command = buildKillRoleWindowCommand('mme-1', 'mme-1:1', 1, '/tmp/example-browser-1');

  assert.match(command, /new-window -t 'mme-1'/);
  assert.match(command, /kill-window -t 'mme-1:1'/);
  assert.match(command, /\\; kill-window/);
  assert.doesNotMatch(command, /&& kill-window/);
  assert.doesNotMatch(command, /kill-session/);
});

test('buildKillRoleWindowCommand kills only the role window when other windows exist', () => {
  assert.equal(
    buildKillRoleWindowCommand('mme-1', 'mme-1:2', 2, '/tmp/example-browser-1'),
    "kill-window -t 'mme-1:2' 2>/dev/null",
  );
});

test('buildPrepareWindowName keeps one prepare window per run label', () => {
  assert.equal(buildPrepareWindowName('7d1fc152'), 'prepare-7d1fc152');
  assert.notEqual(buildPrepareWindowName('7d1fc152'), 'prepare-7d1fc152-preflight');
});

test('buildPreparePlaceholderCommand avoids GNU-only sleep infinity', () => {
  const command = buildPreparePlaceholderCommand();

  assert.doesNotMatch(command, /sleep infinity/);
  assert.match(command, /sleep 86400/);
});

test('buildPrepareWrappedCommand writes sentinel and preserves output flush on success', () => {
  const command = buildPrepareWrappedCommand('echo ok', '/tmp/prep.exit', '/tmp/prep');

  assert.match(command, /echo "\$__farmslot_status" > '\/tmp\/prep\.exit'/);
  assert.match(command, /sleep 1\nexit "\$__farmslot_status"/);
  assert.doesNotMatch(command, /\(echo ok; echo \$\? >/);
});

test('buildPrepareWrappedCommand runs cmd in a subshell so `exec` inside the hook cannot strand the sentinel', () => {
  const command = buildPrepareWrappedCommand(
    'exec bash preflight.sh',
    '/tmp/prep.exit',
    '/tmp/prep',
  );

  assert.match(command, /\(\nexec bash preflight\.sh\n\)\n__farmslot_status=\$\?/);
});

test('buildPrepareWrappedCommand without keepAliveOnSuccess exits normally after sentinel write', () => {
  const command = buildPrepareWrappedCommand('echo ok', '/tmp/prep.exit', '/tmp/prep');

  assert.doesNotMatch(command, /exec sh -c "while :; do sleep 86400/);
});

test('buildPrepareWrappedCommand with keepAliveOnSuccess keeps the pane alive on success so dev servers survive', () => {
  const command = buildPrepareWrappedCommand('echo ok', '/tmp/prep.exit', '/tmp/prep', {
    keepAliveOnSuccess: true,
  });

  assert.match(
    command,
    /if \[ "\$__farmslot_status" -eq 0 \]; then\n {2}exec sh -c "while :; do sleep 86400; done"/,
  );
});

test('buildPrepareWrappedCommand kills descendant process trees on failure and signal', () => {
  const command = buildPrepareWrappedCommand('false', '/tmp/prep.exit', '/tmp/prep');

  assert.match(command, /__farmslot_kill_tree\(\)/);
  assert.match(command, /pgrep -P "\$parent"/);
  assert.match(command, /__farmslot_cleanup_descendants/);
  assert.match(command, /trap '__farmslot_signal_exit 143' TERM/);
  assert.match(command, /if \[ "\$__farmslot_status" -ne 0 \]; then/);
});

test('buildDevServerPortCleanup skips local gateway port', () => {
  assert.deepEqual(buildDevServerPortCleanup('7777', true, 7777), {
    command: null,
    skippedReason: 'Skipped dev-server cleanup for gateway port 7777',
  });
});

test('buildDevServerPortCleanup still cleans remote gateway-numbered ports', () => {
  assert.deepEqual(buildDevServerPortCleanup('7777', false, 7777), {
    command: 'lsof -ti :7777 2>/dev/null | xargs kill 2>/dev/null; true',
    skippedReason: null,
  });
});

test('buildDevServerPortCleanup rejects non-numeric ports', () => {
  assert.deepEqual(buildDevServerPortCleanup('7777; kill 1', true, 7777), {
    command: null,
    skippedReason: "Invalid dev-server port '7777; kill 1'",
  });
});

test('prepare poll warnings emit first failures then throttle repeated node timeouts', () => {
  assert.equal(shouldEmitPreparePollWarning(1, 1_000, 0), true);
  assert.equal(shouldEmitPreparePollWarning(2, 2_000, 1_000), true);
  assert.equal(shouldEmitPreparePollWarning(3, 3_000, 2_000), true);
  assert.equal(shouldEmitPreparePollWarning(4, 4_000, 3_000), false);
  assert.equal(shouldEmitPreparePollWarning(4, 33_000, 3_000), true);
});

test('prepare phase timeout is separate from short sentinel poll timeout', () => {
  assert.equal(getPrepareSentinelPollTimeoutMs(), 10_000);
  assert.equal(getPreparePreflightTimeoutMs(), 15 * 60_000);
  assert.equal(getPrepareDepsTimeoutMs(), 90 * 60_000);
  assert.ok(getPrepareDepsTimeoutMs() > getPrepareSentinelPollTimeoutMs() * 100);
});

test('successful preflight preserves live pane so dev-server descendants survive', () => {
  assert.equal(shouldPreservePrepareWindowOnSuccess('preflight', '0'), true);
  assert.equal(shouldPreservePrepareWindowOnSuccess('preflight', '1'), false);
  assert.equal(shouldPreservePrepareWindowOnSuccess('deps', '0'), false);
});

test('slotRefreshBlockedReason allows refresh on idle ready slot', () => {
  assert.equal(slotRefreshBlockedReason(makeSlot({ slot: 'demo-1' })), null);
});

test('slotRefreshBlockedReason allows refresh when slot is unknown to the fleet', () => {
  assert.equal(slotRefreshBlockedReason(undefined), null);
});

test('slotRefreshBlockedReason rejects busy lifecycle even without currentRunId', () => {
  const reason = slotRefreshBlockedReason(
    makeSlot({ slot: 'demo-1', lifecycle: 'busy', phase: 'preparing' }),
  );
  assert.match(reason ?? '', /demo-1 is busy/);
  assert.match(reason ?? '', /refresh would discard/);
});

test('slotRefreshBlockedReason rejects held lifecycle and includes run reference', () => {
  const reason = slotRefreshBlockedReason(
    makeSlot({
      slot: 'demo-2',
      lifecycle: 'held',
      phase: 'pr-watch',
      currentRunId: 'abcd1234-5678-90ef-1234-567890abcdef',
    }),
  );
  assert.match(reason ?? '', /demo-2 is held/);
  assert.match(reason ?? '', /run abcd1234/);
});

test('slotRefreshBlockedReason rejects ready lifecycle that still carries a currentRunId', () => {
  // Defends against a stale fleet snapshot where lifecycle has flipped back
  // to ready but the run pointer hasn't cleared yet — the lifecycle alone
  // would say "safe to refresh" but the run state proves otherwise.
  const reason = slotRefreshBlockedReason(
    makeSlot({
      slot: 'demo-3',
      lifecycle: 'ready',
      currentRunId: '11111111-2222-3333-4444-555555555555',
    }),
  );
  assert.match(reason ?? '', /demo-3 is ready/);
  assert.match(reason ?? '', /run 11111111/);
});

test('slotRefreshBlockedReason allows refresh on manual lifecycle without active work', () => {
  // `manual` is human-controlled but not actively dispatched; refresh is fine
  // when there's no currentRunId attached.
  assert.equal(slotRefreshBlockedReason(makeSlot({ slot: 'demo-4', lifecycle: 'manual' })), null);
});
