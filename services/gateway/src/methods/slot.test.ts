import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

import type { SlotStatus } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';

import {
  buildDevServerPortCleanup,
  buildKillRoleWindowCommand,
  buildPrepareNewWindowCommand,
  buildPreparePlaceholderCommand,
  buildPrepareWindowName,
  buildPrepareWrappedCommand,
  formatPrepareSilence,
  getPrepareDepsTimeoutMs,
  getPreparePreflightTimeoutMs,
  getPrepareSentinelPollTimeoutMs,
  prepareSessionTarget,
  refreshStaleBranchDetail,
  refreshSyncUsesIdleReset,
  shouldEmitPreparePollWarning,
  shouldPreservePrepareWindowOnSuccess,
  slotRefreshBlockedReason,
} from './slot.js';

const execFileAsync = promisify(execFile);

function makeSlotVars(
  overrides: Partial<SlotVars> & Pick<SlotVars, 'slotId' | 'session'>,
): SlotVars {
  return {
    machine: 'macwork',
    platform: 'macos',
    host: 'localhost',
    sshUser: 'deeeed',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/tmp/repo',
    remoteRepo: '/tmp/repo',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    projectName: 'farmslot-farm',
    resourceVars: {},
    ...overrides,
  };
}

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

test('buildPrepareWindowName accepts phase-scoped run labels', () => {
  assert.equal(buildPrepareWindowName('7d1fc152'), 'prepare-7d1fc152');
  assert.equal(buildPrepareWindowName('7d1fc152-preflight'), 'prepare-7d1fc152-preflight');
});

test('formatPrepareSilence omits minutes under 60s and includes them above', () => {
  assert.equal(formatPrepareSilence(30_000), '30s');
  assert.equal(formatPrepareSilence(45_000), '45s');
  assert.equal(formatPrepareSilence(60_000), '1m0s');
  assert.equal(formatPrepareSilence(65_000), '1m5s');
  assert.equal(formatPrepareSilence(150_000), '2m30s');
});

test('buildPreparePlaceholderCommand avoids GNU-only sleep infinity', () => {
  const command = buildPreparePlaceholderCommand();

  assert.doesNotMatch(command, /sleep infinity/);
  assert.match(command, /sleep 86400/);
});

test('buildPrepareNewWindowCommand uses an explicit session target', () => {
  const command = buildPrepareNewWindowCommand('core-5', 'prepare-abc123', '/tmp/repo', 'sleep 60');

  assert.match(command, /has-session -t 'core-5'/);
  assert.match(command, /new-session -d -s 'core-5' -c '\/tmp\/repo'/);
  assert.match(command, /new-window -d -t 'core-5:'/);
  assert.equal(prepareSessionTarget('core-5'), 'core-5:');
});

test('buildPrepareNewWindowCommand recreates a missing tmux session before opening window', async (t) => {
  try {
    await execFileAsync('tmux', ['-V'], { timeout: 2000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip('tmux is not installed');
      return;
    }
    throw error;
  }

  const session = `farmslot_prepare_missing_${process.pid}_${Date.now()}`;
  await execFileAsync('tmux', ['kill-session', '-t', session], { timeout: 2000 }).catch(
    () => undefined,
  );
  const command = buildPrepareNewWindowCommand(session, 'prepare-test', '/tmp', 'sleep 60');
  try {
    await execFileAsync('/bin/bash', ['-lc', command], { timeout: 5000 });
    const { stdout } = await execFileAsync(
      'tmux',
      ['list-windows', '-t', session, '-F', '#{window_name}'],
      { timeout: 2000 },
    );
    assert(stdout.split('\n').includes('prepare-test'));
  } finally {
    await execFileAsync('tmux', ['kill-session', '-t', session], { timeout: 2000 }).catch(
      () => undefined,
    );
  }
});

test('buildPrepareWrappedCommand writes sentinel and preserves output flush on success', () => {
  const command = buildPrepareWrappedCommand('echo ok', '/tmp/prep.exit', '/tmp/prep');

  assert.match(command, /echo "\$__farmslot_status" > '\/tmp\/prep\.exit'/);
  assert.match(command, /sleep 1\nexit "\$__farmslot_status"/);
  assert.doesNotMatch(command, /\(echo ok; echo \$\? >/);
});

test('buildPrepareWrappedCommand disarms traps before writing the final child status', () => {
  const command = buildPrepareWrappedCommand('echo ok', '/tmp/prep.exit', '/tmp/prep');
  const finalTrapIdx = command.indexOf('trap - HUP INT TERM\n' + 'echo "$__farmslot_status"');
  const signalTrapIdx = command.indexOf('__farmslot_signal_exit()');

  assert(finalTrapIdx > signalTrapIdx);
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
    command: 'lsof -nP -iTCP:7777 -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null; true',
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

test('refreshStaleBranchDetail allows idle tracking branch on linked worktrees', () => {
  assert.equal(
    refreshStaleBranchDetail(
      'wt/ff-2',
      { slot_tracking_branch: 'wt/{{session}}' },
      makeSlotVars({ slotId: 'macwork-ff-2', session: 'ff-2' }),
      undefined,
      true,
      'main',
    ),
    null,
  );
});

test('refreshStaleBranchDetail rejects feature branches on linked worktrees', () => {
  const detail = refreshStaleBranchDetail(
    'feat/28-add-demo-red-banner',
    { slot_tracking_branch: 'wt/{{session}}' },
    makeSlotVars({ slotId: 'macwork-ff-2', session: 'ff-2' }),
    undefined,
    true,
    'main',
  );
  assert.match(detail ?? '', /STALE_BRANCH/);
  assert.match(detail ?? '', /wt\/ff-2/);
});

test('refreshSyncUsesIdleReset selects idle-reset vs primary fetch path', () => {
  assert.equal(refreshSyncUsesIdleReset('safe', true), true);
  assert.equal(refreshSyncUsesIdleReset('force', false), true);
  assert.equal(refreshSyncUsesIdleReset('safe', false), false);
});

test('refreshStaleBranchDetail rejects mismatched tracking branch on linked worktrees', () => {
  const detail = refreshStaleBranchDetail(
    'wt/ff-1',
    { slot_tracking_branch: 'wt/{{session}}' },
    makeSlotVars({ slotId: 'macwork-ff-2', session: 'ff-2' }),
    undefined,
    true,
    'main',
  );
  assert.match(detail ?? '', /STALE_BRANCH/);
  assert.match(detail ?? '', /wt\/ff-2/);
});

test('refreshStaleBranchDetail allows legacy main on linked worktrees', () => {
  assert.equal(
    refreshStaleBranchDetail(
      'main',
      { slot_tracking_branch: 'wt/{{session}}' },
      makeSlotVars({ slotId: 'macwork-ff-2', session: 'ff-2' }),
      undefined,
      true,
      'main',
    ),
    null,
  );
});

test('refreshStaleBranchDetail rejects non-default branches on primary clones', () => {
  const detail = refreshStaleBranchDetail(
    'feat/demo',
    {},
    makeSlotVars({ slotId: 'macwork-fs-main', session: 'fs-main' }),
    undefined,
    false,
    'main',
  );
  assert.match(detail ?? '', /STALE_BRANCH: on 'feat\/demo', expected 'main'/);
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
