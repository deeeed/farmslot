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
  const grok = path.join(bin, 'grok');
  await writeFile(grok, '#!/bin/sh\nif [ "$1" = live ]; then sleep 300; fi\nexit 0\n');
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
  const liveState = await readRetainedWorkerProgressTarget(vars, live);
  assert.equal(liveState.state, 'unknown', 'a running runner stays unconfirmed');

  process.stdout.write(
    JSON.stringify({ pass: true, exited: exitedState, live: liveState }, null, 2) + '\n',
  );
  passed = true;
} finally {
  await tmux('kill-server').catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
  await rm(socketDir, { recursive: true, force: true });
}
if (!passed) process.exitCode = 1;
