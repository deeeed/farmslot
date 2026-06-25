import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'node:child_process';
import test from 'node:test';

import { maybePromptGithubStar, STAR_REPO, starPromptStatePath, starRepo } from './star-prompt.js';

test('starPromptStatePath lives under ~/.farmslot/state', () => {
  const path = starPromptStatePath({ FARMSLOT_HOME: '/tmp/farmslot-star-home/.farmslot' });
  assert.equal(path, '/tmp/farmslot-star-home/.farmslot/state/star-prompt.json');
});

test('starRepo returns ok when gh repo star succeeds', () => {
  assert.deepEqual(starRepo(STAR_REPO, (() => ({ status: 0, stdout: '', stderr: '' })) as never), {
    ok: true,
  });
});

test('starRepo returns error details when gh exits non-zero', () => {
  const result = starRepo(STAR_REPO, (() => ({
    status: 1,
    stdout: '',
    stderr: 'authentication failed',
  })) as never);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'authentication failed');
});

test('maybePromptGithubStar prints thank-you only when starring succeeds', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  await maybePromptGithubStar({
    env: {},
    stdinIsTTY: true,
    stdoutIsTTY: true,
    hasBeenPromptedFn: async () => false,
    isGhInstalledFn: () => true,
    isGhAuthenticatedFn: () => true,
    markPromptedFn: async () => {},
    askYesNoFn: async () => true,
    starRepoFn: () => ({ ok: true }),
    logFn: (message) => logs.push(message),
    warnFn: (message) => warns.push(message),
  });
  assert.deepEqual(logs, ['[farmslot] Thanks for the star!']);
  assert.deepEqual(warns, []);
});

test('maybePromptGithubStar does not print thank-you when starring fails', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  await maybePromptGithubStar({
    env: {},
    stdinIsTTY: true,
    stdoutIsTTY: true,
    hasBeenPromptedFn: async () => false,
    isGhInstalledFn: () => true,
    isGhAuthenticatedFn: () => true,
    markPromptedFn: async () => {},
    askYesNoFn: async () => true,
    starRepoFn: () => ({ ok: false, error: 'authentication failed' }),
    logFn: (message) => logs.push(message),
    warnFn: (message) => warns.push(message),
  });
  assert.deepEqual(logs, []);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /Could not star repository automatically/);
});

test('maybePromptGithubStar skips when FARMSLOT_NO_STAR_PROMPT is set', async () => {
  let asked = false;
  const prompted = await maybePromptGithubStar({
    env: { FARMSLOT_NO_STAR_PROMPT: '1' },
    stdinIsTTY: true,
    stdoutIsTTY: true,
    askYesNoFn: async () => {
      asked = true;
      return true;
    },
  });
  assert.equal(asked, false);
  assert.equal(prompted, false);
});

test('maybePromptGithubStar skips without a TTY', async () => {
  let asked = false;
  const prompted = await maybePromptGithubStar({
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: true,
    askYesNoFn: async () => {
      asked = true;
      return true;
    },
  });
  assert.equal(asked, false);
  assert.equal(prompted, false);
});

test('maybePromptGithubStar returns true when the question is shown', async () => {
  const prompted = await maybePromptGithubStar({
    env: {},
    stdinIsTTY: true,
    stdoutIsTTY: true,
    hasBeenPromptedFn: async () => false,
    isGhInstalledFn: () => true,
    isGhAuthenticatedFn: () => true,
    markPromptedFn: async () => {},
    askYesNoFn: async () => false,
    starRepoFn: () => ({ ok: true }),
  });
  assert.equal(prompted, true);
});

test('starRepo hides the Windows console window for gh invocations', () => {
  let seenOptions: Record<string, unknown> | undefined;
  starRepo(STAR_REPO, ((_command: string, _args: readonly string[], options?: object) => {
    seenOptions = options as Record<string, unknown>;
    return {
      status: 0,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    } as SpawnSyncReturns<string>;
  }) as never);
  assert.equal(seenOptions?.windowsHide, true);
});
