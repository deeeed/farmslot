import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeToolFromHooks,
  contextPctFromStatusline,
  deriveRunnerActivity,
  parseHookJsonl,
  promptAcceptedFromHooks,
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
    [
      { hook_event_name: 'PreToolUse', observedAt: NOW - 1_000, tool_name: 'Edit' },
    ],
    null,
    NOW,
  );
  assert.equal(toolRunning?.value, 'tool-running');
});

test('activeToolFromHooks returns unmatched PreToolUse tool name', () => {
  const reading = activeToolFromHooks(
    [
      { hook_event_name: 'PreToolUse', observedAt: NOW - 1_000, tool_name: 'Bash' },
    ],
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
  const reading = contextPctFromStatusline(
    { ctxPct: 23.6, observedAt: NOW - 500 },
    NOW,
  );
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
    [{ hook_event_name: 'UserPromptSubmit', observedAt: NOW - 1_000, runnerPromptDigest: 'abc123' }],
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