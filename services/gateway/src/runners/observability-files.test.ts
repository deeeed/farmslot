import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeToolFromHooks,
  contextPctFromStatusline,
  deriveRunnerActivity,
  filterHooksByPane,
  filterStatuslineByPane,
  lastTurnCompletedFromHooks,
  parseHookJsonl,
  promptAcceptedFromHooks,
  promptDigestAcceptedFromHooks,
  promptTurnStartedFromHooks,
  runnerActivityIsBusy,
} from './observability-files.js';

const NOW = 1_782_502_350_000;

test('parseHookJsonl skips malformed tail fragments', () => {
  const records = parseHookJsonl(
    'not-json\n{"hook_event_name":"Stop","observedAt":100}\n{"hook_event_name":"PreToolUse","observedAt":200,"tool_name":"Bash"}',
  );
  assert.equal(records.length, 2);
  assert.equal(records[1]?.tool_name, 'Bash');
});

test('deriveRunnerActivity prefers fresh statusline busy flag', () => {
  const reading = deriveRunnerActivity(
    [],
    { busy: true, observedAt: NOW - 1_000, ctxPct: 42 },
    NOW,
  );
  assert.deepEqual(reading, {
    value: 'tool-running',
    source: 'statusline',
    confidence: 'high',
    observedAt: NOW - 1_000,
  });
});

test('deriveRunnerActivity detects composing and tool-running from hooks', () => {
  const composing = deriveRunnerActivity(
    [
      { hook_event_name: 'Stop', observedAt: NOW - 20_000 },
      { hook_event_name: 'UserPromptSubmit', observedAt: NOW - 2_000 },
    ],
    null,
    NOW,
  );
  assert.equal(composing?.value, 'composing');

  const toolRunning = deriveRunnerActivity(
    [{ hook_event_name: 'PreToolUse', observedAt: NOW - 1_000, tool_name: 'Edit' }],
    null,
    NOW,
  );
  assert.equal(toolRunning?.value, 'tool-running');
});

test('deriveRunnerActivity treats an idle notification after Stop as terminal idle', () => {
  const reading = deriveRunnerActivity(
    [
      { hook_event_name: 'UserPromptSubmit', observedAt: NOW - 80_000 },
      { hook_event_name: 'Stop', observedAt: NOW - 70_000 },
      {
        hook_event_name: 'Notification',
        notification_message: 'Claude is waiting for your input',
        observedAt: NOW - 1_000,
      },
    ],
    null,
    NOW,
  );
  assert.deepEqual(reading, {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: NOW - 1_000,
  });
});

test('deriveRunnerActivity recognizes the installed idle notification message', () => {
  const reading = deriveRunnerActivity(
    [
      { hook_event_name: 'PreToolUse', observedAt: NOW - 70_000, tool_name: 'Read' },
      { hook_event_name: 'PostToolUse', observedAt: NOW - 60_000, tool_name: 'Read' },
      {
        hook_event_name: 'Notification',
        notification_message: 'Claude is waiting for your input',
        observedAt: NOW - 1_000,
      },
    ],
    null,
    NOW,
  );
  assert.equal(reading?.value, 'idle');
});

test('deriveRunnerActivity does not treat an unrelated notification as idle', () => {
  const reading = deriveRunnerActivity(
    [
      { hook_event_name: 'UserPromptSubmit', observedAt: NOW - 2_000 },
      {
        hook_event_name: 'Notification',
        notification_message: 'Claude needs permission to use Bash',
        observedAt: NOW - 1_000,
      },
    ],
    null,
    NOW,
  );
  assert.equal(reading?.value, 'composing');
});

test('deriveRunnerActivity preserves stale terminal idle as low-confidence last-known state', () => {
  const reading = deriveRunnerActivity(
    [
      { hook_event_name: 'Stop', observedAt: NOW - 240_000 },
      // Hook logs written before the installer persisted notification messages have this legacy
      // shape. A notification after a completed turn represents Claude's idle prompt there.
      { hook_event_name: 'Notification', observedAt: NOW - 180_000 },
    ],
    null,
    NOW,
  );
  assert.deepEqual(reading, {
    value: 'idle',
    source: 'hook',
    confidence: 'low',
    observedAt: NOW - 180_000,
    evidence: 'stale-terminal-idle',
  });
});

test('deriveRunnerActivity does not recover stale idle tied with non-idle activity', () => {
  const observedAt = NOW - 180_000;
  const reading = deriveRunnerActivity(
    [
      { hook_event_name: 'Stop', observedAt },
      { hook_event_name: 'PreToolUse', observedAt, tool_name: 'Read' },
    ],
    null,
    NOW,
  );
  assert.equal(reading, null);
});

test('deriveRunnerActivity does not treat SubagentStop as whole-turn idle', () => {
  const reading = deriveRunnerActivity(
    [{ hook_event_name: 'SubagentStop', observedAt: NOW - 180_000 }],
    null,
    NOW,
  );
  assert.equal(reading, null);
});

test('deriveRunnerActivity lets a later Stop close an unmatched tool hook', () => {
  const reading = deriveRunnerActivity(
    [
      { hook_event_name: 'PreToolUse', observedAt: NOW - 70_000, tool_name: 'Bash' },
      { hook_event_name: 'Stop', observedAt: NOW - 60_000 },
    ],
    null,
    NOW,
  );
  assert.deepEqual(reading, {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: NOW - 60_000,
  });
});

test('deriveRunnerActivity rejects terminal idle older than the recovery window', () => {
  const reading = deriveRunnerActivity(
    [{ hook_event_name: 'Stop', observedAt: NOW - 31 * 60_000 }],
    null,
    NOW,
  );
  assert.equal(reading, null);
});

test('lastTurnCompletedFromHooks ignores subagent completion', () => {
  const reading = lastTurnCompletedFromHooks(
    [
      { hook_event_name: 'Stop', observedAt: NOW - 90_000 },
      { hook_event_name: 'SubagentStop', observedAt: NOW - 1_000 },
    ],
    NOW,
  );
  assert.deepEqual(reading, {
    value: NOW - 90_000,
    source: 'hook',
    confidence: 'high',
    observedAt: NOW - 90_000,
  });
});

test('deriveRunnerActivity does not recover stale non-terminal work as idle', () => {
  const reading = deriveRunnerActivity(
    [
      { hook_event_name: 'Stop', observedAt: NOW - 300_000 },
      { hook_event_name: 'UserPromptSubmit', observedAt: NOW - 240_000 },
    ],
    null,
    NOW,
  );
  assert.equal(reading, null);
});

test('activeToolFromHooks returns unmatched PreToolUse tool name', () => {
  const reading = activeToolFromHooks(
    [{ hook_event_name: 'PreToolUse', observedAt: NOW - 1_000, tool_name: 'Bash' }],
    NOW,
  );
  assert.deepEqual(reading, {
    value: 'Bash',
    source: 'hook',
    confidence: 'high',
    observedAt: NOW - 1_000,
  });
});

test('contextPctFromStatusline returns rounded fresh ctx percent', () => {
  const reading = contextPctFromStatusline({ ctxPct: 23.6, observedAt: NOW - 500 }, NOW);
  assert.deepEqual(reading, {
    value: 24,
    source: 'statusline',
    confidence: 'high',
    observedAt: NOW - 500,
  });
});

test('runnerActivityIsBusy treats composing and tool-running as busy', () => {
  assert.equal(runnerActivityIsBusy('composing'), true);
  assert.equal(runnerActivityIsBusy('tool-running'), true);
  assert.equal(runnerActivityIsBusy('idle'), false);
});

test('promptAcceptedFromHooks matches digest after grace window', () => {
  const since = NOW - 10_000;
  const reading = promptAcceptedFromHooks(
    [
      {
        hook_event_name: 'UserPromptSubmit',
        observedAt: NOW - 1_000,
        runnerPromptDigest: 'abc123',
      },
    ],
    'abc123',
    since,
    0,
    NOW,
  );
  assert.deepEqual(reading, {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: NOW - 1_000,
  });
});

test('promptDigestAcceptedFromHooks never substitutes generic turn-start evidence', () => {
  const since = NOW - 30 * 60_000;
  const hooks = [
    {
      hook_event_name: 'UserPromptSubmit',
      observedAt: NOW - 45 * 60_000,
      runnerPromptDigest: 'other-digest',
    },
    { hook_event_name: 'PreToolUse', observedAt: NOW - 20 * 60_000, tool_name: 'Read' },
    { hook_event_name: 'Stop', observedAt: NOW - 10 * 60_000 },
  ];
  assert.deepEqual(promptDigestAcceptedFromHooks(hooks, 'wanted-digest', since, NOW), {
    value: false,
    source: 'hook',
    confidence: 'medium',
    observedAt: NOW - 10 * 60_000,
  });
});

test('promptDigestAcceptedFromHooks requires full window coverage before rejecting a digest', () => {
  const since = NOW - 30 * 60_000;
  const other = {
    hook_event_name: 'UserPromptSubmit',
    observedAt: NOW - 12 * 60_000,
    runnerPromptDigest: 'other-digest',
  };
  assert.equal(promptDigestAcceptedFromHooks([other], 'wanted-digest', since, NOW), null);
  const windowBoundary = {
    hook_event_name: 'Stop',
    observedAt: since,
    tmuxPane: '%other-pane',
  };
  assert.deepEqual(
    promptDigestAcceptedFromHooks(
      [windowBoundary, { ...other, tmuxPane: '%target-pane' }],
      'wanted-digest',
      since,
      NOW,
      '%target-pane',
    ),
    {
      value: false,
      source: 'hook',
      confidence: 'medium',
      observedAt: other.observedAt,
    },
  );
  const matching = { ...other, runnerPromptDigest: 'wanted-digest', observedAt: NOW - 11 * 60_000 };
  assert.deepEqual(promptDigestAcceptedFromHooks([other, matching], 'wanted-digest', since, NOW), {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: matching.observedAt,
  });
});

test('promptDigestAcceptedFromHooks keeps an absent pane-retired stream non-authoritative', () => {
  assert.equal(
    promptDigestAcceptedFromHooks([], 'wanted-digest', NOW - 30 * 60_000, NOW, undefined, true),
    null,
  );
});

test('filterHooksByPane scopes hook records to target pane', () => {
  const hooks = filterHooksByPane(
    [
      { hook_event_name: 'PreToolUse', observedAt: NOW, tmuxPane: '%129' },
      { hook_event_name: 'PreToolUse', observedAt: NOW, tmuxPane: '%91' },
    ],
    '%129',
  );
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0]?.tmuxPane, '%129');
});

test('filterStatuslineByPane ignores another pane in a shared slot', () => {
  const statusline = { busy: true, observedAt: NOW, tmuxPane: '%91' };
  assert.equal(filterStatuslineByPane(statusline, '%129'), null);
  assert.equal(filterStatuslineByPane(statusline, '%91'), statusline);
});

test('promptAcceptedFromHooks: absent hooks are null ONLY under pane retirement, medium-false flag-off', () => {
  const since = NOW - 10_000;
  // Flag-off (default) MUST preserve main's medium-`false` for an absent stream — the null semantics
  // must not leak into the Phase-2 pane-fallback callers (round-3 finding #4 flag-off parity).
  assert.deepEqual(promptAcceptedFromHooks([], 'abc123', since, 0, NOW), {
    value: false,
    source: 'hook',
    confidence: 'medium',
    observedAt: NOW,
  });
  // Pane-retired: a fabricated medium-`false` would let the retirement send path treat a dead hook
  // pipeline as an authoritative decision, so it degrades to null.
  assert.equal(promptAcceptedFromHooks([], 'abc123', since, 0, NOW, undefined, true), null);
});

test('promptAcceptedFromHooks still reports medium false when hooks exist but show no matching prompt', () => {
  const since = NOW - 10_000;
  // Hooks present (runner active) but no UserPromptSubmit for our digest → legit negative evidence.
  const reading = promptAcceptedFromHooks(
    [{ hook_event_name: 'Stop', observedAt: NOW - 1_000 }],
    'abc123',
    since,
    0,
    NOW,
  );
  assert.deepEqual(reading, {
    value: false,
    source: 'hook',
    confidence: 'medium',
    observedAt: NOW,
  });
});

test('promptTurnStartedFromHooks: absent hooks are null ONLY under pane retirement, medium-false flag-off', () => {
  const since = NOW - 10_000;
  // Flag-off (default) preserves main's medium-`false`.
  assert.deepEqual(promptTurnStartedFromHooks([], since, undefined, NOW), {
    value: false,
    source: 'hook',
    confidence: 'medium',
    observedAt: NOW,
  });
  // Pane-retired: absent hooks degrade to null (non-authoritative).
  assert.equal(promptTurnStartedFromHooks([], since, undefined, NOW, 500, true), null);
});

test('promptAcceptedFromHooks reads absent for a pane with no scoped hooks (null ONLY under retirement)', () => {
  const since = NOW - 10_000;
  // Hooks exist but all belong to another pane → no evidence for THIS pane.
  const foreignPaneHooks = [
    { hook_event_name: 'UserPromptSubmit', observedAt: NOW - 1_000, tmuxPane: '%91' },
  ];
  // Flag-off: preserve main's medium-`false`.
  assert.deepEqual(promptAcceptedFromHooks(foreignPaneHooks, 'abc123', since, 0, NOW, '%129'), {
    value: false,
    source: 'hook',
    confidence: 'medium',
    observedAt: NOW,
  });
  // Pane-retired: non-authoritative → null.
  assert.equal(
    promptAcceptedFromHooks(foreignPaneHooks, 'abc123', since, 0, NOW, '%129', true),
    null,
  );
});

test('promptTurnStartedFromHooks treats UserPromptSubmit as medium-confidence ack', () => {
  const since = NOW - 10_000;
  const reading = promptTurnStartedFromHooks(
    [{ hook_event_name: 'UserPromptSubmit', observedAt: NOW - 1_000, tmuxPane: '%129' }],
    since,
    '%129',
    NOW,
  );
  assert.deepEqual(reading, {
    value: true,
    source: 'hook',
    confidence: 'medium',
    observedAt: NOW - 1_000,
  });
});
