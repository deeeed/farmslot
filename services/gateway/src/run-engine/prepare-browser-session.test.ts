import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { ExecResult } from '@farmslot/protocol';

// Same harness as core-prepare.test.ts: real git and the test runner's private tmux server.
const tmuxSandbox =
  !process.env.TMUX &&
  process.env.TMUX_TMPDIR &&
  process.env.FARMSLOT_TMUX_SANDBOX ===
    `${process.env.TMUX_TMPDIR}/tmux-${process.getuid?.() ?? 0}/default`
    ? process.env.FARMSLOT_TMUX_SANDBOX
    : null;

const execFileAsync = promisify(execFile);
const reapedPorts: string[] = [];

const realPrepareCommand = await import('../methods/slot/prepare-command.js');
mock.module('../methods/slot/prepare-command.js', {
  namedExports: {
    ...realPrepareCommand,
    runPrepareCommand: async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
  },
});
const realFixtures = await import('../methods/slot/fixtures.js');
mock.module('../methods/slot/fixtures.js', {
  namedExports: { ...realFixtures, runFixtureSync: async () => undefined },
});
const realReap = await import('../run-lifecycle/browser-session-reap.js');
mock.module('../run-lifecycle/browser-session-reap.js', {
  namedExports: {
    ...realReap,
    reapSlotBrowserSession: async (vars: { resourceVars: Record<string, string> }) => {
      reapedPorts.push(vars.resourceVars.cdp_port ?? '');
      return null;
    },
  },
});

const { slotPrepare } = await import('../methods/slot.js');

// A cancelled run's browser session is left for the next prepare (ADR-054 amendment, 2026-10-19).
// Extension's default profile supplies its own preflight, so the clear cannot hide behind the
// default preflight's dev-server cleanup.
test(
  'a prepare whose profile supplies its own preflight still clears the slot browser session',
  { skip: !tmuxSandbox && 'needs the test runner tmux sandbox (FARMSLOT_TMUX_SANDBOX)' },
  async (t) => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-prepare-browser-'));
    const slotRepo = path.join(fixtureRoot, 'slot');
    const originRepo = path.join(fixtureRoot, 'origin.git');
    const repoRoot = path.resolve(new URL('../../../../', import.meta.url).pathname);
    const slotId = `prepare-browser-${process.pid}`;
    const poolPath = path.join(repoRoot, 'pool', `${slotId}.json`);
    t.after(async () => {
      const session = spawnSync('tmux', ['-S', tmuxSandbox!, 'has-session', '-t', `=${slotId}`]);
      if (session.status === 0)
        await execFileAsync('tmux', ['-S', tmuxSandbox!, 'kill-session', '-t', `=${slotId}`]);
      await rm(poolPath, { force: true });
      await rm(fixtureRoot, { recursive: true, force: true });
    });

    await execFileAsync('git', ['init', '--initial-branch=main', slotRepo]);
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', originRepo]);
    await writeFile(path.join(slotRepo, 'README.md'), 'fixture\n');
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
      `${JSON.stringify({
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
            resources: { 'dev-server': { port: 48809, metro_port: 48879, cdp_port: 48922 } },
          },
        ],
      })}\n`,
    );

    // farmslot-farm's typecheck profile supplies its own preflight hook.
    await slotPrepare(
      { slotId, branch: 'browser-work', prepareProfile: 'typecheck' },
      () => {},
    ).catch(
      () => undefined, // Its health check needs a live sandbox; the clear runs before preflight.
    );
    assert.deepEqual(reapedPorts, ['48922']);
  },
);
