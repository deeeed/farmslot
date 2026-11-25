// A prepare for a run (the Command Center load-run modal, prepare popover and run detail send only
// the run id) uses that run's flow type and domain, here as fixture sync sees them.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { ExecResult } from '@farmslot/protocol';

import '../core/hermetic-git.test-support.js';
import '../core/private-pool.test-support.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'prepare-for-run-context-'));
Object.assign(process.env, {
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: fileURLToPath(new URL('../../../../projects', import.meta.url)),
});

const tmuxSandbox =
  !process.env.TMUX &&
  process.env.TMUX_TMPDIR &&
  process.env.FARMSLOT_TMUX_SANDBOX ===
    `${process.env.TMUX_TMPDIR}/tmux-${process.getuid?.() ?? 0}/default`
    ? process.env.FARMSLOT_TMUX_SANDBOX
    : null;
const needsTmuxSandbox = {
  skip: !tmuxSandbox && 'needs the test runner tmux sandbox (FARMSLOT_TMUX_SANDBOX)',
};
const execFileAsync = promisify(execFile);

const realPrepareCommand = await import('../methods/slot/prepare-command.js');
mock.module('../methods/slot/prepare-command.js', {
  namedExports: {
    ...realPrepareCommand,
    runPrepareCommand: async (): Promise<ExecResult> => ({ stdout: 'ok\n', stderr: '', exitCode: 0 }),
  },
});
const fixtureSyncs: Array<{ flowType?: string; domain?: string }> = [];
const realFixtures = await import('../methods/slot/fixtures.js');
mock.module('../methods/slot/fixtures.js', {
  namedExports: {
    ...realFixtures,
    runFixtureSync: async (_vars: unknown, opts: { flowType?: string; domain?: string }) => {
      fixtureSyncs.push({ flowType: opts.flowType, domain: opts.domain });
    },
  },
});
const realHealth = await import('../methods/slot/prepare-health.js');
mock.module('../methods/slot/prepare-health.js', {
  namedExports: { ...realHealth, verifyPrepareHealth: async () => 'OK' },
});

const { poolDirectory } = await import('../core/config.js');
const { claimSlotStatusIf } = await import('../core/state.js');
const { createRun, deleteRun, persistRunNow, updateRun } = await import('../runs/store.js');
const { slotPrepare } = await import('../methods/slot.js');

test('a prepare for a run uses the run flow type and domain', needsTmuxSandbox, async (t) => {
  const slotRepo = path.join(root, 'slot');
  const originRepo = path.join(root, 'origin.git');
  const slotId = `prepare-for-run-${process.pid}`;
  const poolPath = path.join(poolDirectory(), `${slotId}.json`);
  t.after(async () => {
    spawnSync('tmux', ['-S', tmuxSandbox!, 'kill-session', '-t', `=${slotId}`], { stdio: 'ignore' });
    await rm(poolPath, { force: true });
    await rm(root, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileAsync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]);
  await execFileAsync('git', ['init', '--initial-branch=main', slotRepo]);
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', originRepo]);
  await writeFile(path.join(slotRepo, 'README.md'), 'fixture\n');
  await git(slotRepo, 'add', 'README.md');
  await git(slotRepo, 'commit', '-m', 'fixture');
  await git(slotRepo, 'remote', 'add', 'origin', originRepo);
  await git(slotRepo, 'push', '--set-upstream', 'origin', 'main');
  await writeFile(
    poolPath,
    JSON.stringify({
      machine: os.hostname(),
      project: 'farmslot-farm',
      platform: 'cli',
      host: 'localhost',
      slots: [
        {
          id: slotId,
          repo: slotRepo,
          session: slotId,
          enabled: true,
          mode: 'dispatch',
          resources: { 'dev-server': { port: 48828, metro_port: 48898 } },
        },
      ],
    }),
  );
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'TAT-0000',
    slotId,
    mode: 'autonomous',
    domain: 'perps',
  });
  t.after(async () => {
    await persistRunNow(updateRun(run.id, { status: 'done' }));
    await deleteRun(run.id);
  });
  await claimSlotStatusIf(slotId, () => true, {
    lifecycle: 'ready',
    phase: null,
    agent: 'idle',
    current_run_id: null,
  });

  const result = await slotPrepare(
    { slotId, branch: 'main', runId: run.id, prepareProfile: 'typecheck' },
    () => {},
  );
  assert.equal(result.prepared, true);
  assert.deepEqual(fixtureSyncs, [{ flowType: 'dev', domain: 'perps' }]);
});
