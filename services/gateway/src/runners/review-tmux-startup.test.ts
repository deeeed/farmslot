import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import type { RawPoolJson } from '../core/config.js';

import {
  buildInteractiveRefinementRunnerCommand,
  interactiveRunnerExecutable,
} from './launch-command.js';
import {
  REVIEW_STARTUP_TIMEOUT_MS,
  reviewTmuxStartupState,
  verifiedWarmReviewSessionId,
} from './review-tmux.js';

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
    assert.equal(interactiveRunnerExecutable(options), binary);
    assert.ok(buildInteractiveRefinementRunnerCommand(options)?.includes(binary!), runner);
    assert.ok(
      buildInteractiveRefinementRunnerCommand({ ...options, binary: '/override/runner' })?.includes(
        '/override/runner',
      ),
      runner,
    );
    assert.equal(
      interactiveRunnerExecutable({ ...options, binary: '/override/runner' }),
      '/override/runner',
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
  assert.ok(!command?.includes('check_for_update_on_startup'));
  assert.ok(!command?.includes('features.hooks'));
});

test('a Codex review launch can skip the startup update check and turn hooks off', () => {
  const command = buildInteractiveRefinementRunnerCommand({
    runner: 'codex',
    repo: '/tmp/review.source',
    promptPath: '/tmp/task/prompt.txt',
    model: 'gpt-6-astra',
    workspaceTrust: 'untrusted',
    skipUpdateCheck: true,
    disableHooks: true,
  });
  assert.ok(command?.includes("--config 'check_for_update_on_startup=false'"));
  assert.ok(command?.includes("--config 'features.hooks=false'"));
});

test('a read-only Claude review skips PR settings and hooks while ordinary launches keep them', () => {
  const options = {
    runner: 'claude',
    repo: '/tmp/review.source',
    promptPath: '/tmp/task/prompt.txt',
    model: 'opus',
  };
  const review = buildInteractiveRefinementRunnerCommand({
    ...options,
    workspaceTrust: 'untrusted',
    disableHooks: true,
  });
  assert.ok(review?.includes("'--setting-sources' 'user'"));
  assert.ok(review?.includes(`'--settings' '{"disableAllHooks":true}'`));
  const ordinary = buildInteractiveRefinementRunnerCommand(options);
  assert.ok(!ordinary?.includes('--setting-sources'));
  assert.ok(!ordinary?.includes('disableAllHooks'));
});

test('a Codex review launch allowlists its tool shell environment and refuses secrets', () => {
  const command = buildInteractiveRefinementRunnerCommand({
    runner: 'codex',
    repo: '/tmp/review.source',
    promptPath: '/tmp/task/prompt.txt',
    model: 'gpt-6-astra',
    workspaceTrust: 'untrusted',
    shellEnvironmentNames: [
      'PERPS_LIBRARY',
      'FARMSLOT_SIGNAL_ATTEMPT_ID',
      'CODEX_LB_API_KEY',
      'GH_TOKEN',
      'CODEX_*',
    ],
  });
  const policy = command?.match(/--config '(shell_environment_policy=[^']*)'/)?.[1] ?? '';
  // Arrays are spelled out so Codex's merge replaces any node include_only/exclude.
  assert.match(policy, /^shell_environment_policy=\{inherit="all",exclude=\[\],include_only=\[/);
  for (const name of [
    'PATH',
    'HOME',
    'TMPDIR',
    'PERPS_LIBRARY',
    'FARMSLOT_SIGNAL_ATTEMPT_ID',
    'ZDOTDIR',
  ])
    assert.ok(policy.includes(`"${name}"`), name);
  assert.ok(!policy.includes('CODEX_LB_API_KEY'));
  assert.ok(!policy.includes('GH_TOKEN'));
  assert.ok(!policy.includes('*'), 'a glob would admit names nobody listed');
  assert.ok(policy.endsWith(',set={ZDOTDIR="/var/empty"}}'));
});

test('a missing task mark does not time out or manufacture startup acknowledgment', () => {
  assert.equal(reviewTmuxStartupState(null, null), 'starting');
});

test('unacknowledged review startup blocks after its deadline without pretending to know why', () => {
  assert.equal(
    reviewTmuxStartupState(null, null, {
      startedAt: new Date(started).toISOString(),
      now: started + REVIEW_STARTUP_TIMEOUT_MS - 1,
    }),
    'starting',
  );
  assert.equal(
    reviewTmuxStartupState(null, null, {
      startedAt: new Date(started).toISOString(),
      now: started + REVIEW_STARTUP_TIMEOUT_MS,
    }),
    'blocked',
  );
  assert.equal(
    reviewTmuxStartupState(
      { status: 'running', attemptId: 'fresh', timestamp: new Date(started).toISOString() },
      null,
      { startedAt: new Date(started).toISOString(), now: started + REVIEW_STARTUP_TIMEOUT_MS + 1 },
    ),
    'acknowledged',
  );
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

test('terminal WARM reservation requires exact PR, lineage, session and reviewed-head provenance', () => {
  const trace = {
    mode: 'warm' as const,
    continuity: 'resumed' as const,
    reviewId: 'review-lineage',
    repository: 'owner/repo',
    prNumber: 42,
    priorRunId: 'prior-run',
    priorSessionId: 'prior-session',
    lastReviewedHeadSha: '1111111',
  };
  const run = {
    reviewMode: 'warm',
    ticketOrPr: 'owner/repo#42',
    repeatReviewContext: { mode: 'warm', session: trace },
  } as Run;
  assert.equal(verifiedWarmReviewSessionId(run), 'prior-session');
  assert.equal(verifiedWarmReviewSessionId({ ...run, reviewMode: 'cold' }), undefined);
  for (const session of [
    { ...trace, reviewId: undefined },
    { ...trace, lastReviewedHeadSha: undefined },
    { ...trace, continuity: 'refused' as const },
  ])
    assert.throws(
      () =>
        verifiedWarmReviewSessionId({
          ...run,
          repeatReviewContext: { ...run.repeatReviewContext!, session },
        }),
      /WARM review refused/,
    );
  assert.throws(
    () => verifiedWarmReviewSessionId({ ...run, ticketOrPr: 'owner/repo#43' }),
    /pr-mismatch/,
  );
  assert.equal(
    verifiedWarmReviewSessionId({
      ...run,
      reviewMode: 'cold',
      repeatReviewContext: { ...run.repeatReviewContext!, mode: 'cold' },
    }),
    undefined,
  );
});

test('read-only Grok review stays inside its own sandbox instead of a shared leader', () => {
  const options = {
    runner: 'grok',
    repo: '/tmp/review',
    promptPath: '/tmp/task/prompt.txt',
    model: 'grok-4.7',
  };
  const review = buildInteractiveRefinementRunnerCommand({
    ...options,
    workspaceTrust: 'untrusted',
  });
  assert.ok(review?.includes('--no-leader'));
  assert.ok(!buildInteractiveRefinementRunnerCommand(options)?.includes('--no-leader'));
});
