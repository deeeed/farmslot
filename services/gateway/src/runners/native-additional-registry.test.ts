import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CURSOR_MODEL, DEFAULT_GROK_MODEL, DEFAULT_PI_MODEL } from '@farmslot/protocol';

import { buildInteractiveRefinementRunnerCommand } from './launch-command.js';
import {
  getRunnerDefinition,
  isKnownRunner,
  runnerSupportsEffort,
  runnerSupportsNativeTaskReuse,
} from './registry.js';

test('additional native sessions preserve terminal defaults and support native worker execution', () => {
  for (const [runner, terminalModel, transport] of [
    ['cursor', DEFAULT_CURSOR_MODEL, 'cursor-acp'],
    ['grok', DEFAULT_GROK_MODEL, 'grok-acp'],
  ]) {
    const definition = getRunnerDefinition(runner);
    assert.equal(definition.nativeTransport, transport);
    assert.equal(definition.defaultModel, terminalModel);
    assert.equal(definition.supportsInteractivePrompt, true);
    assert.equal(definition.supportsTmuxNudges, true);
    assert.equal(runnerSupportsNativeTaskReuse(runner), true);
    assert.deepEqual(definition.nativeChoices?.modes, ['default']);
    const nativeDefault = definition.nativeChoices?.defaultModel ?? definition.defaultModel;
    assert.ok(nativeDefault && definition.nativeChoices?.models.includes(nativeDefault));
  }
  assert.equal(runnerSupportsNativeTaskReuse('codex'), true);
  assert.equal(runnerSupportsNativeTaskReuse('claude'), true);
});

test('Pi and OpenCode run natively while their terminal launches stay as they were', () => {
  const pi = getRunnerDefinition('pi');
  assert.equal(pi.nativeTransport, 'pi-rpc');
  assert.equal(pi.defaultModel, DEFAULT_PI_MODEL);
  assert.equal(pi.supportsInteractivePrompt, true);
  assert.equal(pi.nativeChoices?.defaultModel, `xai/${DEFAULT_PI_MODEL}`);
  // No seed: each execution node lists its own models.
  assert.deepEqual(pi.nativeChoices?.models, []);
  assert.ok(pi.modelCatalog && 'nodeCommand' in pi.modelCatalog);

  const opencode = getRunnerDefinition('opencode');
  assert.equal(opencode.nativeTransport, 'opencode-acp');
  assert.equal(opencode.defaultLaunchMode, 'exec');
  assert.equal(opencode.defaultModel, null);
  // A new session takes the model OpenCode is configured with.
  assert.deepEqual(opencode.nativeChoices, { models: [], modes: ['default'] });

  for (const runner of ['pi', 'opencode'])
    assert.equal(runnerSupportsNativeTaskReuse(runner), true);
});

test('Claude Code ACP uses the common native lifecycle with explicit model, effort and interaction modes', () => {
  assert.equal(isKnownRunner('claude-acp'), true);
  const definition = getRunnerDefinition('claude-acp');
  assert.equal(definition.nativeTransport, 'acp');
  assert.deepEqual(definition.nativeChoices?.modes, ['default', 'plan']);
  assert.deepEqual(definition.nativeChoices?.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(runnerSupportsEffort('claude-acp', 'haiku', 'low'), true);
  assert.equal(runnerSupportsNativeTaskReuse('claude-acp'), true);
  assert.equal(getRunnerDefinition('claude').nativeTransport, 'claude-stream-json');
});

test('a native-only agent is refused before constructing a terminal command', () => {
  assert.throws(
    () =>
      buildInteractiveRefinementRunnerCommand({
        runner: 'claude-acp',
        repo: '/private/proof',
        promptPath: '/private/prompt',
      }),
    /requires native transport/,
  );
});
