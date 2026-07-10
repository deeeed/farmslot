import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { poolDir } from '../core/config.js';
import { createRun, deleteRun, getRun, updateRun, updateRunAgentContexts } from '../runs/store.js';

import { restoreTmuxWorker } from './runtime-recovery.js';

const testPoolFile = path.join(poolDir, `runtime-recovery-fixture-${process.pid}.json`);
const slotId = `runtime-recovery-${process.pid}`;
const sessionName = `fs-rt-recovery-${process.pid}`;

function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function killTmuxSession(): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', `=${sessionName}`], { stdio: 'ignore' });
  } catch {
    // Test cleanup only: the session may not exist if setup failed before tmux launch.
  }
}

function launchLiveCodexPane(): void {
  killTmuxSession();
  execFileSync(
    'tmux',
    [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-n',
      'dev',
      '-c',
      process.cwd(),
      'bash -lc "exec -a codex sleep 600"',
    ],
    { stdio: 'ignore' },
  );
}

async function cleanupRun(runId: string): Promise<void> {
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

before(() => {
  mkdirSync(poolDir, { recursive: true });
  writeFileSync(
    testPoolFile,
    JSON.stringify(
      {
        machine: os.hostname(),
        project: 'farmslot-farm',
        platform: 'browser',
        os: 'darwin',
        host: 'localhost',
        ssh_user: os.userInfo().username,
        slots: [
          {
            id: slotId,
            repo: process.cwd(),
            session: sessionName,
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );
});

after(() => {
  killTmuxSession();
  rmSync(testPoolFile, { force: true });
});

test('restore-window preserves working status for an already-live runner', async (t) => {
  if (!tmuxAvailable()) {
    t.skip('tmux unavailable');
    return;
  }
  launchLiveCodexPane();
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `TEST-RESTORE-WINDOW-${process.pid}`,
    runner: 'codex',
    slotId,
  });
  t.after(() => cleanupRun(run.id));

  const result = await restoreTmuxWorker({
    slotId,
    runId: run.id,
    mode: 'restore-window',
  });

  assert.equal(result.restored, true);
  const context = getRun(run.id)?.agentContexts?.find((ctx) => ctx.id === 'dev');
  assert.equal(context?.status, 'working');
  assert.equal(context?.target?.session, sessionName);
  assert.equal(context?.target?.window, 'dev');
  assert.equal(context?.completedAt, undefined);
});

test('reload-session persists live target when the runner is already alive', async (t) => {
  if (!tmuxAvailable()) {
    t.skip('tmux unavailable');
    return;
  }
  launchLiveCodexPane();
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `TEST-RELOAD-LIVE-${process.pid}`,
    runner: 'codex',
    slotId,
  });
  t.after(() => cleanupRun(run.id));
  updateRunAgentContexts(run.id, (_run, contexts) =>
    contexts.map((ctx) =>
      ctx.id === 'dev'
        ? {
            ...ctx,
            status: 'blocked',
            target: null,
            completedAt: '2026-07-10T00:00:00.000Z',
          }
        : ctx,
    ),
  );

  const result = await restoreTmuxWorker({
    slotId,
    runId: run.id,
    mode: 'reload-session',
  });

  assert.equal(result.restored, false);
  assert.equal(result.contexts[0]?.status, 'live');
  const context = getRun(run.id)?.agentContexts?.find((ctx) => ctx.id === 'dev');
  assert.equal(context?.status, 'working');
  assert.equal(context?.target?.session, sessionName);
  assert.equal(context?.target?.window, 'dev');
  assert.equal(context?.completedAt, undefined);
});
