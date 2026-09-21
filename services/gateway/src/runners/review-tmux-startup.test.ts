import assert from 'node:assert/strict';
import test from 'node:test';

import type { RawPoolJson } from '../core/config.js';

import { buildInteractiveRefinementRunnerCommand } from './launch-command.js';
import { REVIEW_TMUX_START_TIMEOUT_MS, reviewTmuxStartupState } from './review-tmux.js';

const started = Date.parse('2026-09-21T09:35:00Z');
const context = { attemptStartedAt: new Date(started).toISOString() };

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

test('a launched terminal without a task signal stays starting and reaches a bounded failure', () => {
  assert.equal(reviewTmuxStartupState(context, null, started), 'starting');
  assert.equal(
    reviewTmuxStartupState(context, null, started + REVIEW_TMUX_START_TIMEOUT_MS),
    'timed-out',
  );
  assert.equal(reviewTmuxStartupState(context, null, started + 2 * 60 * 60_000), 'timed-out');
});

test('a validated task signal acknowledges startup without inferring terminal state', () => {
  assert.equal(
    reviewTmuxStartupState(
      context,
      {
        status: 'running',
        attemptId: 'attempt',
        timestamp: new Date(started + 1000).toISOString(),
      },
      started + 1000,
    ),
    'acknowledged',
  );
});

test('monitor restarts and later delivery bookkeeping do not reset the attempt deadline', () => {
  assert.equal(
    reviewTmuxStartupState(
      {
        ...context,
        promptDeliveryStartedAt: new Date(started + REVIEW_TMUX_START_TIMEOUT_MS).toISOString(),
      },
      null,
      started + REVIEW_TMUX_START_TIMEOUT_MS,
    ),
    'timed-out',
  );
  assert.equal(reviewTmuxStartupState(undefined, null, started), 'timed-out');
  assert.equal(reviewTmuxStartupState({ attemptStartedAt: 'invalid' }, null, started), 'timed-out');
  assert.equal(
    reviewTmuxStartupState(
      { attemptStartedAt: new Date(started + 1).toISOString() },
      null,
      started,
    ),
    'timed-out',
  );
});
