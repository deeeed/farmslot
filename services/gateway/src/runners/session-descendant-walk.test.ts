import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runnerProcessPatternSource } from './registry.js';
import {
  buildFindRunnerDescendantPidCommand,
  RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT,
} from './session-process.js';

/**
 * A reopened session does not run as a direct child of the pane's shell. The
 * operator pastes `bash -lc '<reload command>'`, which execs node, which runs
 * codex — so the runner is a grandchild (or deeper) of the pane process. This
 * exercises the real generated command against a real process tree of that
 * shape; a `pgrep -P`-style direct-children check would miss it.
 */
function runCommand(
  command: string,
  env?: NodeJS.ProcessEnv,
): { exitCode: number; stdout: string; stderr: string } {
  try {
    // `bash -c`, matching execLocal: a login shell would re-source the profile
    // and rebuild PATH, which the shimmed-`ps` cases depend on keeping.
    const stdout = execFileSync('bash', ['-c', command], {
      encoding: 'utf8',
      timeout: 20_000,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

function runProbe(panePid: string, runner: string): { exitCode: number; stdout: string } {
  return runCommand(
    buildFindRunnerDescendantPidCommand(panePid, runnerProcessPatternSource(runner)),
  );
}

/**
 * Run the real generated probe with `ps` replaced by a script of our choosing,
 * so the "the snapshot itself did not happen" branches are exercised end to end
 * rather than simulated at the TypeScript boundary.
 */
function runProbeWithPsShim(
  shimBody: string,
  t: { after(fn: () => void): void },
  // The root must exist in the SHIMMED table, or the walk exits absent before
  // reaching anything the shim is meant to exercise.
  root: string = String(process.pid),
): { exitCode: number; stdout: string; stderr: string } {
  const shimDir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-ps-shim-'));
  t.after(() => rmSync(shimDir, { recursive: true, force: true }));
  writeFileSync(path.join(shimDir, 'ps'), shimBody, { mode: 0o755 });
  return runCommand(
    buildFindRunnerDescendantPidCommand(root, runnerProcessPatternSource('codex')),
    { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}` },
  );
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

test('a ps snapshot that failed is never reported as a confirmed absence', (t) => {
  // A node loaded enough that `ps` cannot fork is the exact scenario this probe
  // exists for. An empty walk over a failed snapshot used to look identical to
  // "the runner is gone", which would let a park release the slot out from
  // under a live worker.
  const probe = runProbeWithPsShim('#!/bin/sh\nexit 1\n', t);

  assert.equal(probe.exitCode, RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT);
  assert.notEqual(probe.exitCode, 1, 'a failed snapshot must not use the confirmed-absent status');
  assert.equal(probe.stdout.trim(), '');
  assert.match(probe.stderr, /ps snapshot exited nonzero/);
});

test('a ps snapshot that returned nothing is never reported as a confirmed absence', (t) => {
  const probe = runProbeWithPsShim('#!/bin/sh\nexit 0\n', t);

  assert.equal(probe.exitCode, RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT);
  assert.match(probe.stderr, /ps snapshot was empty/);
});

test('a ps snapshot with no parsable rows is never reported as a confirmed absence', (t) => {
  // Output that reaches awk but carries no pid rows: the guard has to live in
  // the walk too, not only in the shell check ahead of it.
  const probe = runProbeWithPsShim(
    "#!/bin/sh\nprintf '%s\\n' 'ps: cannot read process table'\n",
    t,
  );

  assert.equal(probe.exitCode, RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT);
  assert.match(probe.stderr, /snapshot unusable \(0 row\(s\), 1 malformed\)/);
});

test('the runner pattern reaches awk with its regex escapes intact', async (t) => {
  // `awk -v pattern='foo\\.bar'` hands awk `foo.bar`, silently widening the
  // match to any character. The pattern travels through ENVIRON instead.
  const decoy = spawn('bash', ['-lc', 'exec -a farmslotXprobe sleep 30'], { stdio: 'ignore' });
  t.after(() => {
    try {
      process.kill(decoy.pid!, 'SIGKILL');
    } catch {
      // Already gone; the assertions below own the outcome, not the cleanup.
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 800));

  const escaped = runCommand(
    buildFindRunnerDescendantPidCommand(String(decoy.pid), 'farmslot\\.probe'),
  );
  assert.equal(escaped.exitCode, 1, 'an escaped dot must not match an arbitrary character');

  const widened = runCommand(
    buildFindRunnerDescendantPidCommand(String(decoy.pid), 'farmslot.probe'),
  );
  assert.equal(widened.exitCode, 0, 'an unescaped dot still matches any character');
  assert.match(widened.stdout.trim(), /^\d+$/);
});

test('a malformed row condemns the snapshot instead of yielding absence', (t) => {
  // `123 garbage` used to count as a valid row, so a table we only partly
  // understood could still produce a CONFIRMED absence — and absence is what
  // frees a slot.
  const probe = runProbeWithPsShim(
    "#!/bin/sh\nprintf '%s\\n' '1 0 Ss /sbin/launchd' '123 garbage'\n",
    t,
  );

  assert.equal(probe.exitCode, RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT);
  assert.notEqual(probe.exitCode, 1, 'a partly-parsed table must not confirm absence');
  assert.match(probe.stderr, /snapshot unusable \(1 row\(s\), 1 malformed\)/);
});

test('a zombie runner is not reported as a live one', (t) => {
  // A zombie has already exited; only its exit status remains. Matching it
  // would report a runner that is gone as still running and settle the park
  // partial.
  const probe = runProbeWithPsShim(
    "#!/bin/sh\nprintf '%s\\n' '1 0 Ss /sbin/launchd' '222 1 Z+ codex'\n",
    t,
    '1',
  );

  assert.equal(probe.exitCode, 1, 'a zombie tree is confirmed absent');
  assert.equal(probe.stdout.trim(), '');
});

test('a live runner in the same shape is still found', (t) => {
  // The control for the zombie case: only the state column may differ.
  const probe = runProbeWithPsShim(
    "#!/bin/sh\nprintf '%s\\n' '1 0 Ss /sbin/launchd' '222 1 S+ codex'\n",
    t,
    '1',
  );

  assert.equal(probe.exitCode, 0);
  assert.equal(probe.stdout.trim(), '222');
});

test('a pid-reuse cycle terminates instead of running until the probe times out', (t) => {
  // An inconsistent snapshot can name one pid twice with different parents, so
  // the ppid edges form a cycle reachable from the root. Without a visited set
  // the walk queues forever and only the exec timeout ends it.
  const started = Date.now();
  const probe = runProbeWithPsShim(
    "#!/bin/sh\nprintf '%s\\n' '1 0 Ss /sbin/launchd' '222 1 S+ sh' '333 222 S+ sh' '222 333 S+ sleep'\n",
    t,
    '1',
  );

  assert.equal(probe.exitCode, 1, 'the cycle resolves to confirmed absence');
  assert.ok(Date.now() - started < 5_000, 'the walk must terminate on its own');
});

test('a row whose state column is not a ps state condemns the snapshot', (t) => {
  // A `ps` that omits STAT shifts every later column left, so `123 1 codex
  // --resume` used to parse as state `codex` and command `--resume` — the
  // runner's own name read as a process state, on a row the walk believed it
  // understood. That is the shape that produces a confirmed absence from a
  // table nobody parsed, and absence is what frees a slot.
  const probe = runProbeWithPsShim(
    "#!/bin/sh\nprintf '%s\\n' '1 0 Ss /sbin/launchd' '123 1 codex --resume'\n",
    t,
  );

  assert.equal(probe.exitCode, RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT);
  assert.notEqual(probe.exitCode, 1, 'a shifted table must not confirm absence');
  assert.match(probe.stderr, /snapshot unusable \(1 row\(s\), 1 malformed\)/);
});

test('the real STAT words both platforms emit are still accepted', (t) => {
  // The validation fails closed, so being too strict would condemn healthy
  // snapshots on the fleet and refuse every park. These are the flag
  // combinations macOS and Linux actually print.
  const probe = runProbeWithPsShim(
    [
      '#!/bin/sh',
      "printf '%s\\n' '1 0 Ss /sbin/launchd' \\",
      "  '2 1 R+ /usr/bin/top' \\",
      "  '3 1 S<sl /usr/bin/audio' \\",
      "  '4 1 I /usr/bin/idle' \\",
      "  '5 1 tN /usr/bin/traced' \\",
      "  '6 1 ?s /usr/bin/unreadable' \\",
      "  '222 1 U codex --resume abc'",
      '',
    ].join('\n'),
    t,
    '1',
  );

  assert.equal(probe.exitCode, 0, `expected a match, got stderr: ${probe.stderr}`);
  assert.equal(probe.stdout.trim(), '222');
});
