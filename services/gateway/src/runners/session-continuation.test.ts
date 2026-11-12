import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from 'shell-quote';

import {
  buildInteractiveRefinementRunnerCommand,
  runnerSessionContinuationArgs,
  runnerSupportsSessionReload,
} from './launch-command.js';
import { runnerSupportsSessionContinuation } from './registry.js';

for (const [runner, expected] of [
  ['claude', ['--resume', 'saved-session']],
  ['codex', ['resume', '--all', 'saved-session']],
  ['pi', ['--session', 'saved-session']],
  ['cursor', ['--resume', 'saved-session']],
  ['grok', ['--resume', 'saved-session']],
] as const) {
  test(`${runner} launches the exact saved session through its shared adapter`, () => {
    assert.deepEqual(runnerSessionContinuationArgs(runner, 'saved-session'), expected);
    const command = buildInteractiveRefinementRunnerCommand({
      runner,
      model: runner === 'pi' ? 'litellm/model' : 'model',
      repo: '/owned/source',
      promptPath: '/owned/task/prompt',
      workspaceTrust: 'untrusted',
      resumeSessionId: 'saved-session',
    });
    assert(command);
    const args = parse(command);
    const at = args.indexOf('saved-session');
    assert(at > 0);
    assert.deepEqual(args.slice(at - expected.length + 1, at + 1), [...expected]);
    assert(runnerSupportsSessionReload(runner));
    assert(runnerSupportsSessionContinuation(runner, 'native'));
  });
}

test('unsupported and unknown adapters cannot inherit another runner resume syntax', () => {
  for (const runner of ['opencode', 'none', 'scripted', 'unregistered']) {
    assert.equal(runnerSupportsSessionContinuation(runner, 'tmux'), false);
    assert.throws(() => runnerSessionContinuationArgs(runner, 'saved-session'), /cannot continue/);
  }
  assert.throws(() => runnerSessionContinuationArgs('claude', '--latest'), /must not start/);
});
