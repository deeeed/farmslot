import assert from 'node:assert/strict';
import test from 'node:test';

import type { RawPoolJson } from '../core/config.js';

import { buildInteractiveRefinementRunnerCommand } from './launch-command.js';
import { reviewTmuxStartupState } from './review-tmux.js';

const started = Date.parse('2026-09-21T09:35:00Z');

test('interactive launch honors each machine runner executable and explicit override', () => {
  const machine: RawPoolJson = {
    machine: 'test',
    project: 'test',
    platform: 'core',
    os: 'darwin',
    host: 'localhost',
    ssh_user: 'test',
    slots: [],
    codex_path: '/local/lb-cli',
    claude_path: '/local/claude',
    cursor_path: '/local/cursor',
    grok_path: '/local/grok',
    pi_path: '/local/pi',
  };
  for (const [runner, binary] of Object.entries({
    codex: machine.codex_path,
    claude: machine.claude_path,
    cursor: machine.cursor_path,
    grok: machine.grok_path,
    pi: machine.pi_path,
  })) {
    const options = { runner, repo: '/tmp/review', promptPath: '/tmp/prompt', machine };
    assert.ok(buildInteractiveRefinementRunnerCommand(options)?.includes(binary!), runner);
    assert.ok(
      buildInteractiveRefinementRunnerCommand({ ...options, binary: '/override/runner' })?.includes(
        '/override/runner',
      ),
      runner,
    );
  }
});

test('read-only Codex review records untrusted workspace policy in launch arguments', () => {
  const command = buildInteractiveRefinementRunnerCommand({
    runner: 'codex',
    repo: '/tmp/review.source',
    promptPath: '/tmp/task/prompt.txt',
    model: 'gpt-6-astra',
    workspaceTrust: 'untrusted',
  });
  assert.ok(command?.includes('projects={"/tmp/review.source"={trust_level="untrusted"}}'));
  assert.ok(!command?.includes('trust_level="trusted"'));
});

test('a missing task mark does not time out or manufacture startup acknowledgment', () => {
  assert.equal(reviewTmuxStartupState(null, null), 'starting');
});

test('native exact-prompt acceptance acknowledges startup before a model-written task mark', () => {
  assert.equal(
    reviewTmuxStartupState(null, {
      runner: 'codex',
      deliveryStartedAt: new Date(started).toISOString(),
      sessionId: 'session',
      sessionPath: '/sessions/session.jsonl',
      observedAt: started + 1000,
      turnToken: 'turn',
    }),
    'acknowledged',
  );
  assert.equal(
    reviewTmuxStartupState(
      { status: 'running', attemptId: 'attempt', timestamp: new Date(started).toISOString() },
      null,
    ),
    'acknowledged',
  );
});
