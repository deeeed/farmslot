import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  // Stands in for Codex: the Folder access screen until Enter or `window` seconds,
  // recording an Enter if one arrives, then a working turn.
  const entered = path.join(directory, 'entered');
  const startCodex = (window: number, cleared: boolean) =>
    assert.equal(
      tmux(
        'new-session',
        '-d',
        '-s',
        session,
        `${cleared ? '' : `cat '${screen}'; if read -t ${window} answer; then touch '${entered}'; fi; clear; `}echo '• Working (1s • esc to interrupt)'; sleep 300`,
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
  const replay = (claimed: boolean, cleared = false) => {
    if (claimed) writeFileSync(path.join(directory, '.terminal-folder-access-claim'), session);
    // An Enter ends the wait at once; the claimed case needs a window to prove none came.
    startCodex(claimed ? 1 : 10, cleared);
    assert.equal(
      tmux('set-option', '-t', session, '@farmslot-review-workspace', session).status,
      0,
    );
    writeFileSync(
      marker,
      JSON.stringify({ ...input, startedAt: 'then', codexHandshake: 'watching' }),
    );
    return spawnSync(process.execPath, [script, JSON.stringify(input)], { encoding: 'utf8' });
  };
  return { marker, replay, tmux, session, entered };
}

const tmuxSkip = {
  skip: !tmuxSandbox && 'needs the test runner tmux sandbox (FARMSLOT_TMUX_SANDBOX)',
};
export { codexReplayFixture, script, tmuxSandbox, tmuxSkip };
