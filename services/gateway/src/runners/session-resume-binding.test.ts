import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildRunnerOpenFileProbeCommand,
  buildRunnerProcessArgvCommand,
  codexArgvResumesSession,
  codexResumeArgvVerdict,
  parseOpenFilePaths,
} from './codex-observability.js';
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

test('an id appearing after the session argument cannot certify the process', () => {
  // The shape that used to pass: a different conversation is being resumed and
  // the expected id merely rides along in a later option or prompt.
  assert.equal(
    codexArgvResumesSession(`codex resume OTHER_ID --model gpt-5.6-sol ${SESSION_ID}`, SESSION_ID),
    false,
  );
  assert.equal(
    codexArgvResumesSession(`codex resume OTHER_ID --config prompt="${SESSION_ID}"`, SESSION_ID),
    false,
  );
});

test('options and their values are skipped when finding the session argument', () => {
  // The exact live shape: flags sit between `resume` and the positional id.
  assert.equal(
    codexArgvResumesSession(
      `codex --config features.hooks=true resume --dangerously-bypass-approvals-and-sandbox --config model_reasoning_effort="xhigh" --model gpt-5.6-sol ${SESSION_ID}`,
      SESSION_ID,
    ),
    true,
  );
  // A value flag must not have its value mistaken for the positional.
  assert.equal(codexArgvResumesSession(`codex resume --model ${SESSION_ID}`, SESSION_ID), false);
  // Inline `--flag=value` consumes no following token.
  assert.equal(
    codexArgvResumesSession(`codex resume --model=gpt-5.6-sol ${SESSION_ID}`, SESSION_ID),
    true,
  );
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
      resolveSessionIdForPath: async () => SESSION_ID,
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
      resolveSessionIdForPath: async () => SESSION_ID,
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
      resolveSessionIdForPath: async () => SESSION_ID,
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
  const argvFn = source.slice(source.indexOf('export function codexResumeArgvVerdict'));
  const body = argvFn.slice(0, argvFn.indexOf('\n}\n') + 3);

  // argv is an explicitly allowed structural signal (process tree and argv).
  // The tokens compared are ones the gateway itself emits in the reload
  // command, never text the runner printed.
  // Tokenised into whole arguments, then compared by equality.
  assert.match(body, /split\(/);
  assert.match(body, /args\.indexOf\('resume'\)/);
  assert.match(body, /arg === trimmedId/);
  // Unknown input fails closed rather than guessing the positional.
  assert.match(body, /unrecognized codex flag/);
  assert.doesNotMatch(body, /stdout/);
  assert.doesNotMatch(body, /capture-pane/);
  // No substring or regex scan of the argv text itself. Array indexOf finds a
  // whole element, which is exactly the comparison the rule asks for.
  assert.doesNotMatch(body, /argv\.(match|includes|indexOf|search)\(/);
  assert.doesNotMatch(body, /\.test\(argv/);
});

test('a resumed binding is rejected when the session file carries a different id', async () => {
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
      verifyResumed: async () => ({ ok: true }),
      // The process claims this session, but the file on disk is another one.
      resolveSessionIdForPath: async () => 'some-other-session',
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /carries session id 'some-other-session'/);
});

test('a resumed binding is rejected when its path cannot be canonicalized', async () => {
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
      canonicalizePath: async () => null,
      verifyResumed: async () => ({ ok: true }),
      resolveSessionIdForPath: async () => SESSION_ID,
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /canonicalization failed/);
});

test('a proven resumed binding reports the canonical path', async () => {
  const result = await verifyExactLiveRunnerSessionBinding(
    makeVars(),
    'codex',
    {
      paneId: '%32',
      slotId: 'macpro-ff-1',
      expectedSessionId: SESSION_ID,
      expectedSessionPath: '/repo/./.agent/codex-home/sessions/rollout-01a06c09.jsonl',
      runnerPid: '6892',
    },
    {
      readPaneStartedAt: async () => 1_788_519_132_869,
      resolveBinding: async () => null,
      canonicalizePath: async () => SESSION_PATH,
      verifyResumed: async () => ({ ok: true }),
      resolveSessionIdForPath: async () => SESSION_ID,
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.binding.canonicalSessionPath, SESSION_PATH);
});

test('an unrecognized flag makes the verdict indeterminate, never a certification', () => {
  // A codex release adding a value flag we have not transcribed would otherwise
  // shift the positional and certify the wrong id.
  const verdict = codexResumeArgvVerdict(
    `codex resume --brand-new-flag something ${SESSION_ID}`,
    SESSION_ID,
  );

  assert.equal(verdict.kind, 'indeterminate');
  if (verdict.kind !== 'indeterminate') return;
  assert.match(verdict.reason, /unrecognized codex flag --brand-new-flag/);
  // The convenience wrapper must never turn indeterminate into a yes.
  assert.equal(
    codexArgvResumesSession(`codex resume --brand-new-flag x ${SESSION_ID}`, SESSION_ID),
    false,
  );
});

test('a variadic image flag is indeterminate because the positional is unknowable', () => {
  const verdict = codexResumeArgvVerdict(
    `codex resume --image a.png b.png ${SESSION_ID}`,
    SESSION_ID,
  );

  assert.equal(verdict.kind, 'indeterminate');
  if (verdict.kind !== 'indeterminate') return;
  assert.match(verdict.reason, /variadic codex flag --image/);
  assert.equal(
    codexResumeArgvVerdict(`codex resume -i a.png ${SESSION_ID}`, SESSION_ID).kind,
    'indeterminate',
  );
});

test('every transcribed codex resume flag still finds the session argument', () => {
  // Value flags consume their argument; boolean flags do not.
  for (const flag of [
    '--config k=v',
    '-c k=v',
    '--enable feat',
    '--disable feat',
    '--remote ws://h:1',
    '--remote-auth-token-env TOKEN',
    '--model gpt-5.6-sol',
    '-m gpt-5.6-sol',
    '--local-provider ollama',
    '--profile prof',
    '-p prof',
    '--sandbox workspace-write',
    '-s workspace-write',
    '--cd /repo',
    '-C /repo',
    '--add-dir /extra',
    '--ask-for-approval never',
    '-a never',
  ]) {
    assert.equal(
      codexResumeArgvVerdict(`codex resume ${flag} ${SESSION_ID}`, SESSION_ID).kind,
      'resumes',
      `value flag ${flag}`,
    );
  }
  for (const flag of [
    '--all',
    '--include-non-interactive',
    '--strict-config',
    '--oss',
    '--approve-for-me',
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
    '--search',
    '--no-alt-screen',
  ]) {
    assert.equal(
      codexResumeArgvVerdict(`codex resume ${flag} ${SESSION_ID}`, SESSION_ID).kind,
      'resumes',
      `boolean flag ${flag}`,
    );
  }
});

test('a boolean flag never swallows the session argument', () => {
  // If `--all` were mistaken for a value flag the id would be skipped.
  assert.equal(
    codexResumeArgvVerdict(`codex resume --all ${SESSION_ID}`, SESSION_ID).kind,
    'resumes',
  );
  // And a value flag must still consume exactly one token.
  assert.equal(
    codexResumeArgvVerdict(`codex resume --model ${SESSION_ID}`, SESSION_ID).kind,
    'other-session',
  );
});

test('an indeterminate argv verdict surfaces as indeterminate, not a proven absence', async () => {
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
        indeterminate: true,
        reason: 'unrecognized codex flag --brand-new-flag',
      }),
      resolveSessionIdForPath: async () => SESSION_ID,
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.indeterminate, true);
  assert.match(result.reason, /unrecognized codex flag/);
});

test('the real manual resume argv with -C between resume and the id parses', () => {
  // Exact shape seen live on macpro for a hand-typed resume.
  assert.equal(
    codexResumeArgvVerdict(
      'codex resume --dangerously-bypass-approvals-and-sandbox -C /Users/example/dev/repo 01a06ac7-1111-2222-3333-444455556666',
      '01a06ac7-1111-2222-3333-444455556666',
    ).kind,
    'resumes',
  );
  // `-C` consumes the directory, so the directory is never read as the id.
  assert.equal(
    codexResumeArgvVerdict(
      'codex resume -C /Users/example/dev/repo 01a06ac7-1111-2222-3333-444455556666',
      '/Users/example/dev/repo',
    ).kind,
    'other-session',
  );
});

test('--last is indeterminate because the positional becomes the prompt', () => {
  // `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`; --last omits SESSION_ID and
  // picks by recency, so the first positional is a prompt, not an id.
  const verdict = codexResumeArgvVerdict(`codex resume --last ${SESSION_ID}`, SESSION_ID);

  assert.equal(verdict.kind, 'indeterminate');
  if (verdict.kind !== 'indeterminate') return;
  assert.match(verdict.reason, /--last resumes by recency/);
  assert.equal(codexArgvResumesSession(`codex resume --last ${SESSION_ID}`, SESSION_ID), false);
});

test('open file handles are read from lsof machine-readable output', () => {
  const command = buildRunnerOpenFileProbeCommand('6892');
  // macOS keeps lsof in /usr/sbin, which is absent from some non-login PATHs.
  assert.match(command, /command -v lsof/);
  assert.match(command, /\/usr\/sbin\/lsof/);
  assert.match(command, /-p '6892' -F n/);
  // A missing binary exits non-zero, which the caller reports as
  // indeterminate — never as proof the session is gone.
  assert.match(command, /exit 127/);
  // `-F n` emits one field per line; only `n` lines are paths.
  assert.deepEqual(
    parseOpenFilePaths(['p6892', 'fcwd', 'n/repo', 'ftxt', `n${SESSION_PATH}`, 'n'].join('\n')),
    ['/repo', SESSION_PATH],
  );
  assert.deepEqual(parseOpenFilePaths(''), []);
});

test('argv is recorded but never decides: the open handle certifies', async () => {
  // `ps -o args=` joins argv with spaces, so `--config 'note = <uuid>'` can put
  // the expected id where a positional would be. argv says `resumes` here, and
  // the process does NOT hold the rollout open, so it must not be certified.
  let openProbes = 0;
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
      resolveSessionIdForPath: async () => SESSION_ID,
      verifyResumed: async () => {
        openProbes += 1;
        return {
          ok: false,
          indeterminate: true,
          reason: `runner process 6892 does not hold ${SESSION_PATH} open`,
        };
      },
    },
  );

  assert.equal(openProbes, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.indeterminate, true);
  assert.match(result.reason, /does not hold .* open/);
});

test('the canonical path is what the open-handle check is given', async () => {
  let handedPath;
  await verifyExactLiveRunnerSessionBinding(
    makeVars(),
    'codex',
    {
      paneId: '%32',
      slotId: 'macpro-ff-1',
      expectedSessionId: SESSION_ID,
      expectedSessionPath: '/repo/./.agent/codex-home/sessions/rollout-01a06c09.jsonl',
      runnerPid: '6892',
    },
    {
      readPaneStartedAt: async () => 1_788_519_132_869,
      resolveBinding: async () => null,
      canonicalizePath: async () => SESSION_PATH,
      resolveSessionIdForPath: async () => SESSION_ID,
      verifyResumed: async (_vars, _runner, _pid, _id, expectedSessionPath) => {
        handedPath = expectedSessionPath;
        return { ok: true };
      },
    },
  );

  // A non-canonical path would never match an lsof entry.
  assert.equal(handedPath, SESSION_PATH);
});

test('a flattened argv value cannot falsely reject a valid resume', () => {
  // `-C '/path with spaces'` splits under `ps`, so the real session argument is
  // hidden and a fragment looks positional. The parser says other-session here,
  // which is exactly why its verdict must not gate certification.
  const verdict = codexResumeArgvVerdict(
    `codex resume -C /Users/example/my dev/repo ${SESSION_ID}`,
    SESSION_ID,
  );
  assert.equal(verdict.kind, 'other-session');
});

test('the codex provider never lets an argv verdict deny a held handle', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, 'codex-observability.ts'), 'utf8');
  const fn = source.slice(source.indexOf('async verifyResumedSessionBinding('));
  const body = fn.slice(0, fn.indexOf('\n  },\n') + 5);

  // argv is computed for diagnosis only.
  assert.match(body, /argvVerdict/);
  // No early return on the argv verdict: the handle decides.
  assert.doesNotMatch(body, /is not resuming session/);
  assert.doesNotMatch(body, /verdict\.kind !== 'resumes'/);
  // Certification is the open handle on the canonical path.
  assert.match(body, /parseOpenFilePaths\(open\.stdout\)\.includes\(expectedSessionPath\)/);
});
