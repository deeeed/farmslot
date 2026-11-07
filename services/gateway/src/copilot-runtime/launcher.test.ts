import assert from 'node:assert/strict';
import test from 'node:test';

import { getRunnerDefinition } from '../runners/registry.js';

import { resolveCopilotRunner, resolveOperatorCheckout } from './launcher.js';

test('all installed copilot runners select the shared native capability', () => {
  for (const runner of ['claude', 'codex', 'cursor', 'grok', 'pi', 'opencode']) {
    const selected = resolveCopilotRunner({ runner });
    assert.equal(selected.runner, runner);
    assert.ok(getRunnerDefinition(runner).nativeTransport);
  }
});
test('operator checkout resolves from configuration', () => {
  const previous = process.env.FARMSLOT_OPERATOR_CHECKOUT;
  process.env.FARMSLOT_OPERATOR_CHECKOUT = '/gateway/configured/root';
  try {
    assert.equal(resolveOperatorCheckout(), '/gateway/configured/root');
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_OPERATOR_CHECKOUT;
    else process.env.FARMSLOT_OPERATOR_CHECKOUT = previous;
  }
});
test('copilot selects low effort without mutating ordinary runner defaults', () => {
  const ordinary = getRunnerDefinition('codex');
  assert.equal(resolveCopilotRunner({ runner: 'codex', model: 'gpt-6-astra' }).effort, 'low');
  assert.equal(getRunnerDefinition('codex'), ordinary);
});
