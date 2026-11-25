// A prepare's hooks see FARMSLOT_FLOW_TYPE beside FARMSLOT_PREPARE_PROFILE, so a pack can set up
// a runtime for a dev run without doing it for a review of the same domain.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { ExecResult } from '@farmslot/protocol';

import '../core/hermetic-git.test-support.js';
import '../core/private-pool.test-support.js';

import { poolDirectory } from '../core/config.js';
import { claimSlotStatusIf } from '../core/state.js';

// Real tmux only on the test runner's private server (scripts/quality/run-tsx-tests.mjs).
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
const commands: string[] = [];

const realPrepareCommand = await import('../methods/slot/prepare-command.js');
mock.module('../methods/slot/prepare-command.js', {
  namedExports: {
    ...realPrepareCommand,
    runPrepareCommand: async (
      _vars: unknown,
      _logPath: string,
      command: string,
    ): Promise<ExecResult> => {
      commands.push(command);
      return { stdout: 'ok\n', stderr: '', exitCode: 0 };
    },
  },
});
const realFixtures = await import('../methods/slot/fixtures.js');
mock.module('../methods/slot/fixtures.js', {
  namedExports: { ...realFixtures, runFixtureSync: async () => undefined },
});

const { slotPrepare } = await import('../methods/slot.js');

test('prepare hooks see the flow type of the prepare, and none without one', needsTmuxSandbox, async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-prepare-flow-env-'));
  const slotRepo = path.join(fixtureRoot, 'slot');
  const originRepo = path.join(fixtureRoot, 'origin.git');
  const slotId = `prepare-flow-env-${process.pid}`;
  const poolPath = path.join(poolDirectory(), `${slotId}.json`);
  t.after(async () => {
    const session = spawnSync('tmux', ['-S', tmuxSandbox!, 'has-session', '-t', `=${slotId}`], {
      encoding: 'utf8',
    });
    if (session.status === 0)
      await execFileAsync('tmux', ['-S', tmuxSandbox!, 'kill-session', '-t', `=${slotId}`]);
    await rm(poolPath, { force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  await execFileAsync('git', ['init', '--initial-branch=main', slotRepo]);
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', originRepo]);
  await writeFile(path.join(slotRepo, 'README.md'), 'flow env fixture\n');
  await execFileAsync('git', ['-C', slotRepo, 'add', 'README.md']);
  await execFileAsync('git', [
    '-C',
    slotRepo,
    '-c',
    'user.name=Farmslot Test',
    '-c',
    'user.email=farmslot-test@example.invalid',
    'commit',
    '-m',
    'fixture',
  ]);
  await execFileAsync('git', ['-C', slotRepo, 'remote', 'add', 'origin', originRepo]);
  await execFileAsync('git', ['-C', slotRepo, 'push', '--set-upstream', 'origin', 'main']);
  await writeFile(
    poolPath,
    `${JSON.stringify(
      {
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
            resources: { 'dev-server': { port: 48818, metro_port: 48888 } },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const prepare = async (flowType?: string) => {
    commands.length = 0;
    await claimSlotStatusIf(slotId, () => true, {
      lifecycle: 'ready',
      phase: null,
      agent: 'idle',
      current_run_id: null,
    });
    const result = await slotPrepare(
      { slotId, branch: 'main', prepareProfile: 'typecheck', ...(flowType ? { flowType } : {}) },
      () => {},
    );
    assert.equal(result.prepared, true);
    return [...commands];
  };

  const dev = await prepare('dev');
  const preflight = dev.filter((command) => command.includes('yarn typecheck'));
  assert.ok(preflight.length > 0, 'the preflight hook ran');
  for (const command of preflight) assert.match(command, /export FARMSLOT_FLOW_TYPE='dev'/);
  const deps = dev.filter((command) => command.includes('yarn install'));
  assert.ok(deps.length > 0, 'the deps hook ran');
  for (const command of deps) assert.match(command, /export FARMSLOT_FLOW_TYPE='dev'/);

  const none = await prepare();
  assert.ok(none.some((command) => command.includes('yarn typecheck')), 'the preflight hook ran');
  for (const command of none) assert.doesNotMatch(command, /FARMSLOT_FLOW_TYPE/);
});
