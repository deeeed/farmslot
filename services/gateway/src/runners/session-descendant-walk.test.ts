import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';

import { runnerProcessPatternSource } from './registry.js';
import { buildFindRunnerDescendantPidCommand } from './session-process.js';

/**
 * A reopened session does not run as a direct child of the pane's shell. The
 * operator pastes `bash -lc '<reload command>'`, which execs node, which runs
 * codex — so the runner is a grandchild (or deeper) of the pane process. This
 * exercises the real generated command against a real process tree of that
 * shape; a `pgrep -P`-style direct-children check would miss it.
 */
function runProbe(panePid: string, runner: string): { exitCode: number; stdout: string } {
  const command = buildFindRunnerDescendantPidCommand(panePid, runnerProcessPatternSource(runner));
  try {
    const stdout = execFileSync('bash', ['-lc', command], { encoding: 'utf8', timeout: 20_000 });
    return { exitCode: 0, stdout };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string };
    return { exitCode: failure.status ?? 1, stdout: failure.stdout ?? '' };
  }
}

test('the descendant walk finds a codex runner nested under bash -lc and node', async (t) => {
  // `bash -lc` -> `node` -> a process whose command line matches the codex
  // runner pattern: the exact shape a pasted reopen command produces.
  const child = spawn(
    'bash',
    ['-lc', `exec node -e "process.title='codex'; setTimeout(()=>{}, 30000)" codex-resume-probe`],
    { stdio: 'ignore', detached: false },
  );
  t.after(() => {
    try {
      process.kill(child.pid!, 'SIGKILL');
    } catch {
      // Already gone: the assertions below own the outcome, not the cleanup.
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.ok(child.pid, 'probe tree did not start');

  const probe = runProbe(String(child.pid), 'codex');

  assert.equal(probe.exitCode, 0, `walk did not find the nested runner: ${probe.stdout}`);
  assert.match(probe.stdout.trim(), /^\d+$/, 'walk must return a pid');
});

test('the descendant walk reports absence for a tree with no runner', async (t) => {
  const child = spawn('bash', ['-lc', 'exec sleep 30'], { stdio: 'ignore' });
  t.after(() => {
    try {
      process.kill(child.pid!, 'SIGKILL');
    } catch {
      // Already gone.
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const probe = runProbe(String(child.pid), 'codex');

  // Exit 1 with no stdout is the contract's "confirmed absent", distinct from
  // an unknown/transport failure.
  assert.equal(probe.exitCode, 1);
  assert.equal(probe.stdout.trim(), '');
});
