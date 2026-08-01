import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  filterHooksByPane,
  promptAcceptedFromHooks,
  promptTurnStartedFromHooks,
} from './observability-files.js';
import {
  buildLaunchAckSignalReadCommand,
  launchAckSignalAdvanced,
} from './prompt-delivery-evidence.js';

const NOW = 1_782_502_350_000;

test('filterHooksByPane keeps unscoped hooks and matching pane hooks', () => {
  const hooks = [
    { hook_event_name: 'PreToolUse', observedAt: NOW, tmuxPane: '%129' },
    { hook_event_name: 'PreToolUse', observedAt: NOW, tmuxPane: '%91' },
    { hook_event_name: 'Stop', observedAt: NOW },
  ];
  const scoped = filterHooksByPane(hooks, '%129');
  assert.equal(scoped.length, 2);
  assert.ok(scoped.some((record) => record.tmuxPane === '%129'));
  assert.ok(scoped.some((record) => record.tmuxPane == null));
});

test('promptTurnStartedFromHooks accepts PreToolUse on scoped pane', () => {
  const since = NOW - 10_000;
  const reading = promptTurnStartedFromHooks(
    [
      {
        hook_event_name: 'PreToolUse',
        observedAt: NOW - 1_000,
        tmuxPane: '%129',
        tool_name: 'Read',
      },
    ],
    since,
    '%129',
    NOW,
  );
  assert.equal(reading?.value, true);
  assert.equal(reading?.confidence, 'high');
});

test('promptTurnStartedFromHooks ignores other panes when scoped', () => {
  const since = NOW - 10_000;
  const foreignPaneHooks = [
    {
      hook_event_name: 'PreToolUse',
      observedAt: NOW - 1_000,
      tmuxPane: '%91',
      tool_name: 'Bash',
    },
  ];
  // Flag-off (default) MUST preserve main's medium-`false` — the ADR-032 null-on-absent semantics
  // must not leak into the Phase-2 pane-fallback callers (round-3 finding #4 flag-off parity).
  assert.deepEqual(promptTurnStartedFromHooks(foreignPaneHooks, since, '%129', NOW), {
    value: false,
    source: 'hook',
    confidence: 'medium',
    observedAt: NOW,
  });
  // Pane-retired: no hook evidence for THIS pane is non-authoritative (degraded), not a fabricated
  // confident `false` that could mask an absent hook pipeline as an authoritative read.
  assert.equal(promptTurnStartedFromHooks(foreignPaneHooks, since, '%129', NOW, 500, true), null);
});

test('promptAcceptedFromHooks accepts turn start without digest match', () => {
  const since = NOW - 10_000;
  const reading = promptAcceptedFromHooks(
    [
      { hook_event_name: 'UserPromptSubmit', observedAt: NOW - 2_000, tmuxPane: '%129' },
      {
        hook_event_name: 'PreToolUse',
        observedAt: NOW - 1_000,
        tmuxPane: '%129',
        tool_name: 'Read',
      },
    ],
    'missing-digest',
    since,
    0,
    NOW,
    '%129',
  );
  assert.equal(reading?.value, true);
});

test('launch acknowledgement accepts any valid worker signal that advances from its baseline', () => {
  const baseline = { raw: null, status: null, mtimeNs: '0' };
  const running = {
    raw: '{"status":"running"}',
    status: 'running',
    mtimeNs: `${NOW}000000`,
  };
  const rewritten = { ...running, mtimeNs: `${NOW}000001` };
  const complete = {
    raw: '{"status":"complete"}',
    status: 'complete',
    mtimeNs: `${NOW + 1000}000000`,
  };

  assert.equal(launchAckSignalAdvanced(baseline, running, NOW), true);
  assert.equal(launchAckSignalAdvanced(running, running, NOW), false);
  assert.equal(launchAckSignalAdvanced(running, rewritten, NOW), true);
  assert.equal(launchAckSignalAdvanced(running, complete, NOW), true);
});

test('launch acknowledgement rejects malformed or stale signals', () => {
  assert.equal(
    launchAckSignalAdvanced(null, { raw: '{}', status: null, mtimeNs: `${NOW}000000` }, NOW),
    false,
  );
  assert.equal(
    launchAckSignalAdvanced(
      null,
      { raw: '{"status":"running"}', status: 'running', mtimeNs: `${NOW}000000` },
      NOW,
    ),
    false,
  );
});

test('launch acknowledgement stat probe emits one numeric timestamp on this platform', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farmslot-launch-ack-'));
  const signalPath = join(dir, 'SIGNAL.json');
  try {
    writeFileSync(signalPath, '{"status":"running"}\n');
    const output = execFileSync('/bin/sh', ['-c', buildLaunchAckSignalReadCommand(signalPath)], {
      encoding: 'utf8',
    });
    const [mtime, raw] = output.split('\n');
    assert.match(mtime, /^\d+$/);
    assert.equal(raw, '{"status":"running"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
