import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/review-terminal.cjs', import.meta.url));

// Real tmux only on the test runner's private server (scripts/quality/run-tsx-tests.mjs):
// no $TMUX, and plain `tmux` (the script under test) resolving to that socket.
const tmuxSandbox =
  !process.env.TMUX &&
  process.env.TMUX_TMPDIR &&
  process.env.FARMSLOT_TMUX_SANDBOX ===
    `${process.env.TMUX_TMPDIR}/tmux-${process.getuid?.() ?? 0}/default`
    ? process.env.FARMSLOT_TMUX_SANDBOX
    : null;

test(
  'review receipt reuse binds runner and model without replacing the owned terminal',
  {
    skip: !tmuxSandbox && 'needs the test runner tmux sandbox (FARMSLOT_TMUX_SANDBOX)',
  },
  (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'review-receipt-'));
    const session = `receipt-${process.pid}-${Date.now()}`;
    const input = {
      action: 'launch',
      runId: session,
      workspaceId: session,
      session,
      task: directory,
      cwd: directory,
      runner: 'cursor',
      model: 'claude-opus-5-5-high',
    };
    const marker = path.join(directory, '.terminal-launch.json');
    const receipt = { ...input, startedAt: new Date().toISOString(), signalAttemptId: 'unchanged' };
    const tmux = (...args: string[]) =>
      spawnSync('tmux', ['-S', tmuxSandbox!, ...args], { encoding: 'utf8' });
    context.after(() => {
      const alive = tmux('has-session', '-t', `=${session}`);
      if (alive.status === 0) assert.equal(tmux('kill-session', '-t', session).status, 0);
      else assert.equal(alive.status, 1);
      rmSync(directory, { recursive: true, force: true });
    });
    assert.equal(tmux('new-session', '-d', '-s', session, 'sleep 300').status, 0);
    assert.equal(
      tmux('set-option', '-t', session, '@farmslot-review-workspace', session).status,
      0,
    );
    const invoke = (overrides = {}) =>
      spawnSync(process.execPath, [script, JSON.stringify({ ...input, ...overrides })], {
        encoding: 'utf8',
      });
    writeFileSync(marker, JSON.stringify(receipt));
    const matched = invoke();
    assert.equal(matched.status, 0, matched.stderr);
    assert.deepEqual(JSON.parse(matched.stdout), receipt);
    for (const overrides of [{ runner: 'grok' }, { model: 'different-model' }]) {
      const rejected = invoke(overrides);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /does not match the requested runner and model/);
      assert.equal(tmux('has-session', '-t', `=${session}`).status, 0);
      assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), receipt);
      assert.equal(existsSync(path.join(directory, '.terminal-cancelled')), false);
    }
    const legacy = { ...receipt, runner: undefined, model: undefined };
    writeFileSync(marker, JSON.stringify(legacy));
    assert.match(invoke().stderr, /does not match the requested runner and model/);
    assert.equal(tmux('has-session', '-t', `=${session}`).status, 0);
    writeFileSync(marker, JSON.stringify(receipt));
    assert.equal(invoke({ action: 'stop' }).status, 0);
    assert.equal(tmux('has-session', '-t', `=${session}`).status, 1);
    assert.match(invoke().stderr, /launch was cancelled/);
    assert.equal(readFileSync(path.join(directory, '.terminal-cancelled'), 'utf8'), session);
  },
);

/** A review task whose terminal stands in for Codex, replayed with a given launch marker. */
function codexReplayFixture(context: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-handshake-'));
  const session = `handshake-${process.pid}-${Date.now()}`;
  const input = {
    action: 'launch',
    runId: session,
    workspaceId: session,
    session,
    task: directory,
    cwd: directory,
    runner: 'codex',
    model: 'gpt-6.1-sol',
  };
  const marker = path.join(directory, '.terminal-launch.json');
  const screen = path.join(directory, 'screen.txt');
  writeFileSync(
    screen,
    [
      'Folder access',
      '',
      directory,
      '',
      'Config, hooks, and exec policies from untrusted folders stay disabled.',
      'Trusted project folders can still contribute settings. Skills still load,',
      'and tools follow your permission settings. Opening will not change saved',
      'trust.',
      '',
      '› 1. Open restricted',
      '  2. Quit',
      '',
      '  enter continue · esc quit',
      '',
    ].join('\n'),
  );
  const tmux = (...args: string[]) =>
    spawnSync('tmux', ['-S', tmuxSandbox!, ...args], { encoding: 'utf8' });
  // Stands in for Codex: the Folder access screen until Enter, then a working turn.
  const startCodex = () =>
    assert.equal(
      tmux(
        'new-session',
        '-d',
        '-s',
        session,
        `cat '${screen}'; read answer; clear; echo '• Working (1s • esc to interrupt)'; sleep 300`,
      ).status,
      0,
    );
  const stopCodex = () => {
    if (tmux('has-session', '-t', `=${session}`).status === 0)
      assert.equal(tmux('kill-session', '-t', session).status, 0);
  };
  context.after(() => {
    stopCodex();
    rmSync(directory, { recursive: true, force: true });
  });
  const replay = (handshake: string) => {
    startCodex();
    assert.equal(
      tmux('set-option', '-t', session, '@farmslot-review-workspace', session).status,
      0,
    );
    writeFileSync(
      marker,
      JSON.stringify({ ...input, startedAt: 'then', codexHandshake: handshake }),
    );
    return spawnSync(process.execPath, [script, JSON.stringify(input)], { encoding: 'utf8' });
  };
  return { marker, replay, tmux, session };
}

const tmuxSkip = {
  skip: !tmuxSandbox && 'needs the test runner tmux sandbox (FARMSLOT_TMUX_SANDBOX)',
};

test(
  'a Codex launch replayed before its answer resumes the Folder access handshake',
  tmuxSkip,
  (context) => {
    const { marker, replay, tmux, session } = codexReplayFixture(context);
    // The helper died before answering: the replay answers once and records it.
    const resumed = replay('watching');
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).folderAccess, 'restricted');
    const saved = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(saved.codexHandshake, 'done');
    assert.equal(saved.folderAccess, 'restricted');
    assert.match(tmux('capture-pane', '-p', '-t', session).stdout, /esc to interrupt/);
  },
);

test('a Codex launch replayed after its answer never sends a second Enter', tmuxSkip, (context) => {
  const { marker, replay, tmux, session } = codexReplayFixture(context);
  // The helper died after its answer: Folder access still up fails, no second Enter.
  const answered = replay('answered');
  assert.notEqual(answered.status, 0);
  assert.match(answered.stderr, /still shows Folder access after Open restricted/);
  assert.equal(tmux('has-session', '-t', `=${session}`).status, 1);
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).codexHandshake, 'answered');
});
