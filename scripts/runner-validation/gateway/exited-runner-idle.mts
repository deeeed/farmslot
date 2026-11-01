// Live proof on an isolated tmux server: a tmux worker whose runner exited reads idle at a
// handoff while its pane survives as the role shell; one whose runner still runs does not (F287).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AgentContext } from '@farmslot/protocol';

const execute = promisify(execFile);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const scratch = await mkdtemp(path.join(tmpdir(), 'exited-runner-idle-'));
// Every tmux call in this process, the gateway's included, reaches only this proof's server.
// A short directory keeps the server socket under the platform's path limit.
const socketDir = await mkdtemp('/tmp/eri-');
process.env.TMUX_TMPDIR = socketDir;
process.env.TMUX = '';
const tmux = (...args: string[]) => execute('tmux', args, { env: process.env });
const grok = path.join(scratch, 'bin', 'grok');

/** True when no process of this proof's server or its workers is left. */
async function proofProcessesGone(): Promise<boolean> {
  const { stdout } = await execute('ps', ['-axo', 'command=']);
  return !stdout.split('\n').some((line) => line.includes(socketDir) || line.includes(scratch));
}

let cleaning: Promise<void> | undefined;
/** Stop the proof's tmux server, confirm its processes are gone, then remove its files. */
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    let refused: unknown;
    try {
      await tmux('kill-server');
    } catch (error) {
      // An absent server (never started, or already stopped) is expected. Any other refusal
      // fails the cleanup unless the server and its workers are confirmed gone below.
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      if (!/no server running|error connecting to/u.test(stderr)) refused = error;
    }
    const deadline = Date.now() + 5_000;
    while (!(await proofProcessesGone())) {
      if (Date.now() > deadline)
        throw new Error('Proof tmux server or workers are still running', { cause: refused });
      await pause(100);
    }
    // The socket directory goes only once nothing can still listen on it.
    await rm(scratch, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true });
  })();
  return cleaning;
}

// A cancelled or timed-out recipe still tears the server down: signals and the proof's own
// deadline (inside the recipe's 60 s) run the same cleanup, then fail the run.
async function abort(reason: string): Promise<never> {
  process.stderr.write(`${reason}\n`);
  try {
    await cleanup();
  } catch (error) {
    process.stderr.write(
      `Proof cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    process.exit(1);
  }
}
process.once('SIGINT', () => void abort('Interrupted; proof server stopped'));
process.once('SIGTERM', () => void abort('Terminated; proof server stopped'));
const proofDeadline = setTimeout(() => void abort('Proof timed out after 45 s'), 45_000);

const { buildRoleLaunchCommandWithDiagnosticHold } =
  await import('../../../services/gateway/src/methods/dispatch/execute.js');
const { readRetainedWorkerProgressTarget } =
  await import('../../../services/gateway/src/runners/retained-worker-progress.js');
const { probeRunnerDescendantPid } =
  await import('../../../services/gateway/src/runners/session-process.js');
const { makeVars } = await import('../../../services/gateway/src/runners/test-fixtures.js');

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}

let passed = false;
try {
  const repo = path.join(scratch, 'repo');
  const bin = path.join(scratch, 'bin');
  await mkdir(repo, { recursive: true });
  await mkdir(bin, { recursive: true });
  // A stand-in runner named like Grok: `live` keeps running, anything else exits 0.
  // The live loop stays in this process, so stopping the pane leaves no long-lived child.
  await writeFile(
    grok,
    '#!/bin/sh\nif [ "$1" = live ]; then while :; do sleep 1; done; fi\nexit 0\n',
  );
  await chmod(grok, 0o755);
  const vars = makeVars({ remoteRepo: repo, repo });
  const worker = async (session: string, command: string): Promise<AgentContext> => {
    await tmux(
      'new-session',
      '-d',
      '-s',
      session,
      '-n',
      'dev',
      buildRoleLaunchCommandWithDiagnosticHold(command, repo),
    );
    const { stdout } = await tmux('display-message', '-p', '-t', `${session}:dev`, '#{pane_id}');
    return {
      runId: 'proof',
      slotId: vars.slotId,
      id: session,
      role: 'dev',
      label: 'Worker',
      status: 'complete',
      runner: 'grok',
      target: { session, window: 'dev', target: `${session}:dev`, paneId: stdout.trim() },
    };
  };
  const panePid = async (context: AgentContext) =>
    (
      await tmux('display-message', '-p', '-t', context.target!.paneId!, '#{pane_pid}')
    ).stdout.trim();

  const exited = await worker('proof-exited', grok);
  await waitFor(
    async () =>
      (await tmux('capture-pane', '-p', '-t', exited.target!.paneId!)).stdout.includes(
        '[farmslot] runner launch command exited 0',
      ),
    'the runner exits 0 and the pane survives',
  );
  const exitedState = await readRetainedWorkerProgressTarget(vars, exited);
  assert.deepEqual(exitedState, { state: 'absent' }, 'an exited runner reads idle');

  const live = await worker('proof-live', `${grok} live`);
  await waitFor(
    async () =>
      (await probeRunnerDescendantPid(vars, await panePid(live), 'grok')).state === 'present',
    'the live runner is running',
  );
  // Cleanup checks interrupt the proof here, with both workers running.
  await pause(Number(process.env.EXITED_RUNNER_IDLE_HOLD_MS ?? 0));
  const liveState = await readRetainedWorkerProgressTarget(vars, live);
  assert.equal(liveState.state, 'unknown', 'a running runner stays unconfirmed');

  process.stdout.write(
    JSON.stringify({ pass: true, exited: exitedState, live: liveState }, null, 2) + '\n',
  );
  passed = true;
} finally {
  clearTimeout(proofDeadline);
  await cleanup();
}
if (!passed) process.exitCode = 1;
