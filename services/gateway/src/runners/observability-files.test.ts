import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeToolFromHooks,
  contextPctFromStatusline,
  deriveRunnerActivity,
  filterHooksByPane,
  parseHookJsonl,
  promptAcceptedFromHooks,
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

test('promptAcceptedFromHooks returns null for an entirely absent hook stream (degraded, not confident false)', () => {
  const since = NOW - 10_000;
  // No hook records at all → non-authoritative. A fabricated medium-`false` here would let the
  // ADR-032 pane-retirement send path treat a dead hook pipeline as an authoritative decision.
  assert.equal(promptAcceptedFromHooks([], 'abc123', since, 0, NOW), null);
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

test('promptTurnStartedFromHooks returns null for an absent hook stream', () => {
  const since = NOW - 10_000;
  assert.equal(promptTurnStartedFromHooks([], since, undefined, NOW), null);
});

test('promptAcceptedFromHooks reads absent for a pane that has no scoped hooks', () => {
  const since = NOW - 10_000;
  // Hooks exist but all belong to another pane → no evidence for THIS pane → non-authoritative.
  const reading = promptAcceptedFromHooks(
    [{ hook_event_name: 'UserPromptSubmit', observedAt: NOW - 1_000, tmuxPane: '%91' }],
    'abc123',
    since,
    0,
    NOW,
    '%129',
  );
  assert.equal(reading, null);
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
