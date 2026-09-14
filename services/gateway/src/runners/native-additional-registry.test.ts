import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CURSOR_MODEL, DEFAULT_GROK_MODEL } from '@farmslot/protocol';

import { getRunnerDefinition, runnerSupportsNativeTaskReuse } from './registry.js';

test('additional native sessions preserve terminal defaults and withhold unproven worker capabilities', () => {
  for (const [runner, terminalModel, transport] of [
    ['cursor', DEFAULT_CURSOR_MODEL, 'cursor-acp'],
    ['grok', DEFAULT_GROK_MODEL, 'grok-acp'],
  ]) {
    const definition = getRunnerDefinition(runner);
    assert.equal(definition.nativeTransport, transport);
    assert.equal(definition.defaultModel, terminalModel);
    assert.equal(definition.supportsInteractivePrompt, true);
    assert.equal(definition.supportsTmuxNudges, true);
    assert.equal(runnerSupportsNativeTaskReuse(runner), false);
    assert.deepEqual(definition.nativeChoices?.modes, ['default']);
    const nativeDefault = definition.nativeChoices?.defaultModel ?? definition.defaultModel;
    assert.ok(nativeDefault && definition.nativeChoices?.models.includes(nativeDefault));
  }
  assert.equal(runnerSupportsNativeTaskReuse('codex'), true);
  assert.equal(runnerSupportsNativeTaskReuse('claude'), true);
});
