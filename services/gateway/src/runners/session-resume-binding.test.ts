import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildRunnerProcessArgvCommand, codexArgvResumesSession } from './codex-observability.js';
import { verifyExactLiveRunnerSessionBinding } from './session-process.js';
import { makeVars } from './test-fixtures.js';

/** Exact argv observed live from a reopened codex session on macpro-ff-1. */
const RESUMED_ARGV =
  '/Users/example/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex ' +
  '--config features.hooks=true resume --dangerously-bypass-approvals-and-sandbox ' +
  '--config model_reasoning_effort="xhigh" --model gpt-5.6-sol 01a06c09-7ff7-7902-8abe-331a6e3a17c2';

const SESSION_ID = '01a06c09-7ff7-7902-8abe-331a6e3a17c2';
const SESSION_PATH = '/repo/.agent/codex-home/sessions/rollout-01a06c09.jsonl';

test('the codex resume argv proves ownership of exactly that session', () => {
  assert.equal(codexArgvResumesSession(RESUMED_ARGV, SESSION_ID), true);
});

test('argv for a different session, or a fresh launch, proves nothing', () => {
  // Same process shape, different conversation.
  assert.equal(
    codexArgvResumesSession(RESUMED_ARGV, '01a06c09-0000-0000-0000-000000000000'),
    false,
  );
  // A fresh launch has no `resume` subcommand even if an id appears elsewhere.
  assert.equal(
    codexArgvResumesSession(`codex --model gpt-5.6-sol ${SESSION_ID}`, SESSION_ID),
    false,
  );
  assert.equal(codexArgvResumesSession('', SESSION_ID), false);
  assert.equal(codexArgvResumesSession(RESUMED_ARGV, '   '), false);
});

test('a session id that merely contains another is not a match', () => {
  // Substring matching would bind the wrong conversation.
  assert.equal(codexArgvResumesSession(`codex resume ${SESSION_ID}abc`, SESSION_ID), false);
  assert.equal(codexArgvResumesSession(`codex resume x${SESSION_ID}`, SESSION_ID), false);
});

test('the argv probe reads the process, never a pane', () => {
  const command = buildRunnerProcessArgvCommand('6892');
  assert.match(command, /^ps -p '6892' -o args=/);
  assert.doesNotMatch(command, /capture-pane/);
});

test('exact-binding verification falls back to the resumed check when attribution is empty', async () => {
  const result = await verifyExactLiveRunnerSessionBinding(
    makeVars(),
    'codex',
    {
      paneId: '%32',
      slotId: 'macpro-ff-1',
      expectedSessionId: SESSION_ID,
      expectedSessionPath: SESSION_PATH,
      runnerPid: '6892',
    },
    {
      // Pane started AFTER the transcript was written — the resumed shape.
      readPaneStartedAt: async () => 1_788_519_132_869,
      resolveBinding: async () => null,
      canonicalizePath: async (_vars, sessionPath) => sessionPath,
      verifyResumed: async (_vars, _runner, runnerPid, expectedSessionId) => ({
        ok: runnerPid === '6892' && expectedSessionId === SESSION_ID,
      }),
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.binding.runnerSessionId, SESSION_ID);
  assert.equal(result.binding.runnerSessionPath, SESSION_PATH);
});

test('without a proven runner pid the resumed fallback is never consulted', async () => {
  let consulted = 0;
  const result = await verifyExactLiveRunnerSessionBinding(
    makeVars(),
    'codex',
    {
      paneId: '%32',
      slotId: 'macpro-ff-1',
      expectedSessionId: SESSION_ID,
      expectedSessionPath: SESSION_PATH,
    },
    {
      readPaneStartedAt: async () => 1_788_519_132_869,
      resolveBinding: async () => null,
      canonicalizePath: async (_vars, sessionPath) => sessionPath,
      verifyResumed: async () => {
        consulted += 1;
        return { ok: true };
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(consulted, 0);
});

test('a live process resuming a different session does not satisfy the check', async () => {
  const result = await verifyExactLiveRunnerSessionBinding(
    makeVars(),
    'codex',
    {
      paneId: '%32',
      slotId: 'macpro-ff-1',
      expectedSessionId: SESSION_ID,
      expectedSessionPath: SESSION_PATH,
      runnerPid: '6892',
    },
    {
      readPaneStartedAt: async () => 1_788_519_132_869,
      resolveBinding: async () => null,
      canonicalizePath: async (_vars, sessionPath) => sessionPath,
      verifyResumed: async () => ({
        ok: false,
        reason: 'runner process 6892 is not resuming session ' + SESSION_ID,
      }),
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not resuming session/);
});

/**
 * Standing rule: runner state is never derived from runner stdout, stderr, or
 * TUI text. Every runner prints differently and output changes between
 * releases. These guard the session-identity modules this PR introduced.
 */
test('the session-identity modules never read pane or runner text', () => {
  const dir = path.resolve(import.meta.dirname);
  for (const file of [
    'session-rediscovery.ts',
    'session-record.ts',
    'session-resume-binding-sources.ts',
  ]) {
    const full = path.join(dir, file);
    if (!existsSync(full)) continue;
    const source = readFileSync(full, 'utf8');
    assert.doesNotMatch(source, /capture-pane/, `${file} must not capture pane text`);
    assert.doesNotMatch(
      source,
      /runnerLineLooksWaiting|paneShows/,
      `${file} must not read TUI text`,
    );
  }
});

test('resumed-session ownership reads the process table, not runner output', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, 'codex-observability.ts'), 'utf8');
  const argvFn = source.slice(source.indexOf('export function codexArgvResumesSession'));
  const body = argvFn.slice(0, argvFn.indexOf('\n}\n') + 3);

  // argv is an explicitly allowed structural signal (process tree and argv).
  // The tokens compared are ones the gateway itself emits in the reload
  // command, never text the runner printed.
  assert.match(body, /split\(/);
  assert.match(body, /includes\('resume'\)/);
  assert.doesNotMatch(body, /stdout/);
  assert.doesNotMatch(body, /capture-pane/);
  // Whole-argument comparison only: no substring or regex scan of the argv.
  assert.doesNotMatch(body, /\.match\(|indexOf\(|\.test\(/);
});
