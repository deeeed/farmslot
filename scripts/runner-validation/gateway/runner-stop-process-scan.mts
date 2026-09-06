#!/usr/bin/env tsx
/**
 * Living proof for the runner-stop pane-tree liveness probe (MANUAL-000121).
 *
 * The probe decides whether a runner is still alive under a tmux pane. A park
 * releases the slot on the strength of that answer, so two properties matter
 * and both are asserted here against real processes and the real generated
 * command, not a mock:
 *
 *   1. Cost. One `ps` snapshot walked in `awk`, instead of a `pgrep -P` plus a
 *      `ps -p` per visited process. Counted by shimming both binaries.
 *   2. Fail-closed. A `ps` that did not happen must never read as "the runner
 *      is gone". Forced by shimming `ps` to fail, to print nothing, and to
 *      print rows the walk cannot parse.
 *
 * Run it against two trees to get fail-before/pass-after: the wrapper scenario
 * passes FARMSLOT_VALIDATION_SOURCE_ROOT for the baseline checkout and again
 * for the working tree.
 *
 * usage:
 *   FARMSLOT_VALIDATION_SOURCE_ROOT=<repo> \
 *   FARMSLOT_VALIDATION_RESULT_PATH=<out.json> \
 *   yarn exec tsx scripts/runner-validation/gateway/runner-stop-process-scan.mts
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Node {
  id: string;
  claim: string;
  pass: boolean;
  observed: unknown;
}

const sourceRoot = path.resolve(process.env.FARMSLOT_VALIDATION_SOURCE_ROOT ?? process.cwd());
const resultPath = process.env.FARMSLOT_VALIDATION_RESULT_PATH;
assert.ok(resultPath, 'FARMSLOT_VALIDATION_RESULT_PATH is required');

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'farmslot-stop-scan-'));
const nodes: Node[] = [];
const cleanup: Array<() => void> = [() => rmSync(tempRoot, { recursive: true, force: true })];

function record(id: string, claim: string, pass: boolean, observed: unknown): void {
  nodes.push({ id, claim, pass, observed });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${claim}`);
}

/**
 * `bash -c`, matching the gateway's own local exec layer. A login shell would
 * rebuild PATH from the profile and throw away the shims below.
 */
function runShell(command: string, env?: NodeJS.ProcessEnv): ShellResult {
  const result = spawnSync('bash', ['-c', command], {
    encoding: 'utf8',
    timeout: 60_000,
    env: env ?? process.env,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * A PATH front-runner for `ps` and `pgrep`. `body` is the whole script, so a
 * shim can either fail on purpose or delegate to the real binary while
 * appending a line to a counter file.
 */
function shimDir(shims: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tempRoot, 'shim-'));
  for (const [name, body] of Object.entries(shims)) {
    writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  }
  return dir;
}

function withShims(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` };
}

function countingShim(name: string, real: string, tally: string): string {
  return `#!/bin/sh\nprintf '%s\\n' '${name}' >> ${tally}\nexec ${real} "$@"\n`;
}

function whichOrThrow(binary: string): string {
  const found = execFileSync('bash', ['-lc', `command -v ${binary}`], { encoding: 'utf8' }).trim();
  assert.ok(found, `${binary} is required for this proof`);
  return found;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function tallyCount(tally: string, name: string): number {
  try {
    return readFileSync(tally, 'utf8')
      .split('\n')
      .filter((line) => line.trim() === name).length;
  } catch (error) {
    // A missing file means the shim was never invoked, which is a real
    // observation. A permission or I/O error is not, and silently reading it as
    // "zero forks" would turn a broken proof into a passing one.
    if (isErrnoCode(error, 'ENOENT')) return 0;
    throw error;
  }
}

/** SIGKILL a process, tolerating only the race where it already exited. */
function killIfAlive(pid: number, label: string): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (isErrnoCode(error, 'ESRCH')) return;
    throw new Error(
      `could not kill ${label} (pid ${pid}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main(): Promise<void> {
  const sessionProcess = (await import(
    pathToFileURL(path.join(sourceRoot, 'services/gateway/src/runners/session-process.ts')).href
  )) as {
    buildFindRunnerDescendantPidCommand(panePid: string, pattern: string): string;
  };
  const registry = (await import(
    pathToFileURL(path.join(sourceRoot, 'services/gateway/src/runners/registry.ts')).href
  )) as { runnerProcessPatternSource(runnerId?: string | null): string };

  const claudePattern = registry.runnerProcessPatternSource('claude');
  const build = (panePid: string, pattern = claudePattern) =>
    sessionProcess.buildFindRunnerDescendantPidCommand(panePid, pattern);

  // ── A real pane tree, inside the tmux pane it is inspected in ─────────────
  // Every observation below roots at the SAME pane PID. Launching the tree
  // outside the pane and then checking absence inside it would prove nothing:
  // the second reading would be of an unrelated process tree.
  const session = `runner-stop-scan-${process.pid}`;
  const workdir = mkdtempSync(path.join(tempRoot, 'repo-'));
  execFileSync('tmux', ['new-session', '-d', '-s', session, '-c', workdir, 'bash', '--norc']);
  cleanup.push(() => spawnSync('tmux', ['kill-session', '-t', session]));
  const panePid = execFileSync('tmux', ['display-message', '-p', '-t', session, '#{pane_pid}'], {
    encoding: 'utf8',
  }).trim();
  assert.match(panePid, /^\d+$/, 'tmux did not report a pane PID');

  // A branching tree, not a chain: the old walk's cost scaled with the number
  // of processes it visited, so a single-process tree would hide the very
  // difference this proof is about. The runner sits two levels down, the shape
  // a launched or reopened worker actually has.
  const treeScript = path.join(tempRoot, 'pane-tree.sh');
  const treePidFile = path.join(tempRoot, 'pane-tree.pid');
  writeFileSync(
    treeScript,
    [
      '#!/bin/bash',
      'sleep 240 &',
      'sleep 240 &',
      'sleep 240 &',
      `bash -c 'exec bash -lc "exec -a claude sleep 240"' &`,
      'wait',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  execFileSync('tmux', [
    'send-keys',
    '-t',
    session,
    `${treeScript} & echo $! > ${treePidFile}`,
    'Enter',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const treePid = Number(readFileSync(treePidFile, 'utf8').trim());
  assert.ok(Number.isInteger(treePid) && treePid > 0, 'pane tree did not report its PID');
  cleanup.push(() => {
    spawnSync('pkill', ['-9', '-P', String(treePid)]);
    killIfAlive(treePid, 'pane tree');
  });

  const found = runShell(build(panePid));
  record(
    'walk-finds-the-nested-runner',
    'the generated walk finds a runner nested under the tmux pane process',
    found.exitCode === 0 && /^\d+$/.test(found.stdout.trim()),
    { paneRoot: panePid, exitCode: found.exitCode, stdout: found.stdout.trim() },
  );

  // ── Cost: how many process-table reads one probe costs ────────────────────
  const realPs = whichOrThrow('ps');
  const realPgrep = whichOrThrow('pgrep');
  const tally = path.join(tempRoot, 'forks.log');
  const counting = shimDir({
    ps: countingShim('ps', realPs, tally),
    pgrep: countingShim('pgrep', realPgrep, tally),
  });
  const countedStart = Date.now();
  const counted = runShell(build(panePid), withShims(counting));
  const countedMs = Date.now() - countedStart;
  const psCalls = tallyCount(tally, 'ps');
  const pgrepCalls = tallyCount(tally, 'pgrep');
  const treeSize = runShell(`pgrep -d' ' -P ${String(treePid)} | wc -w`).stdout.trim();
  record(
    'one-probe-reads-the-process-table-once',
    'a probe of a branching pane tree costs exactly one process-table read and no per-node pgrep',
    counted.exitCode === 0 && psCalls === 1 && pgrepCalls === 0,
    {
      psCalls,
      pgrepCalls,
      directChildrenOfRoot: Number(treeSize),
      exitCode: counted.exitCode,
      elapsedMs: countedMs,
    },
  );

  // ── Fail-closed: a snapshot that did not happen ───────────────────────────
  // Confirmed absence is exit 1 with nothing on either stream. Anything the
  // caller must not read as absence has to differ on that exact signature.
  const failedSnapshot = runShell(
    build(panePid),
    withShims(shimDir({ ps: '#!/bin/sh\nexit 1\n', pgrep: '#!/bin/sh\nexit 1\n' })),
  );
  record(
    'a-failed-ps-is-not-a-confirmed-absence',
    'a `ps` that exits nonzero is reported as undecided, not as a stopped runner',
    failedSnapshot.exitCode !== 1 && failedSnapshot.stderr.trim() !== '',
    {
      exitCode: failedSnapshot.exitCode,
      stderr: failedSnapshot.stderr.trim(),
      confirmedAbsentSignature: failedSnapshot.exitCode === 1 && !failedSnapshot.stderr.trim(),
    },
  );

  const emptySnapshot = runShell(
    build(panePid),
    withShims(shimDir({ ps: '#!/bin/sh\nexit 0\n', pgrep: '#!/bin/sh\nexit 0\n' })),
  );
  record(
    'an-empty-ps-is-not-a-confirmed-absence',
    'a `ps` that returns no output is reported as undecided, not as a stopped runner',
    emptySnapshot.exitCode !== 1 && emptySnapshot.stderr.trim() !== '',
    {
      exitCode: emptySnapshot.exitCode,
      stderr: emptySnapshot.stderr.trim(),
      confirmedAbsentSignature: emptySnapshot.exitCode === 1 && !emptySnapshot.stderr.trim(),
    },
  );

  const unparsableSnapshot = runShell(
    build(panePid),
    withShims(
      shimDir({
        ps: "#!/bin/sh\nprintf '%s\\n' 'ps: cannot read the process table'\n",
        pgrep: '#!/bin/sh\nexit 1\n',
      }),
    ),
  );
  record(
    'an-unparsable-ps-is-not-a-confirmed-absence',
    'output that reaches the walk with no pid rows is reported as undecided',
    unparsableSnapshot.exitCode !== 1 && unparsableSnapshot.stderr.trim() !== '',
    {
      exitCode: unparsableSnapshot.exitCode,
      stderr: unparsableSnapshot.stderr.trim(),
      confirmedAbsentSignature:
        unparsableSnapshot.exitCode === 1 && !unparsableSnapshot.stderr.trim(),
    },
  );

  // ── The runner pattern must not be widened on its way to the matcher ──────
  const decoy = spawn('bash', ['-lc', 'exec -a farmslotXprobe sleep 240'], { stdio: 'ignore' });
  cleanup.push(() => killIfAlive(decoy.pid!, 'pattern decoy'));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const escaped = runShell(build(String(decoy.pid), 'farmslot\\.probe'));
  const widened = runShell(build(String(decoy.pid), 'farmslot.probe'));
  record(
    'the-runner-pattern-keeps-its-regex-escapes',
    'an escaped dot in the runner pattern still matches only a literal dot',
    escaped.exitCode === 1 && widened.exitCode === 0,
    { escapedExit: escaped.exitCode, widenedExit: widened.exitCode },
  );

  // ── Confirmed absence, on a tree whose runner really is gone ──────────────
  // The same pane, the same root, after its runner tree is gone. Absence is
  // only meaningful as a SECOND reading of the tree the first reading found.
  spawnSync('pkill', ['-9', '-P', String(treePid)]);
  killIfAlive(treePid, 'pane tree');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const absent = runShell(build(panePid));
  record(
    'a-tree-with-no-runner-is-confirmed-absent',
    'a pane whose runner exited reports the confirmed-absent signature: exit 1, nothing printed',
    absent.exitCode === 1 && !absent.stdout.trim() && !absent.stderr.trim(),
    { exitCode: absent.exitCode, stdout: absent.stdout.trim(), stderr: absent.stderr.trim() },
  );

  writeFileSync(
    resultPath!,
    `${JSON.stringify(
      {
        sourceRoot,
        sourceSha: process.env.FARMSLOT_VALIDATION_SOURCE_SHA ?? null,
        loadAverage: os.loadavg(),
        cpus: os.cpus().length,
        nodes,
        pass: nodes.every((node) => node.pass),
      },
      null,
      2,
    )}\n`,
  );
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`runner-stop-process-scan failed: ${message}`);
    mkdirSync(path.dirname(resultPath!), { recursive: true });
    writeFileSync(
      resultPath!,
      `${JSON.stringify(
        { sourceRoot, error: message, nodes, pass: false, loadAverage: os.loadavg() },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    for (const step of cleanup.reverse()) step();
  });
