import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { promisify } from 'node:util';

import type { ExecResult } from '@farmslot/protocol';

// Real tmux only on the test runner's private server (scripts/quality/run-tsx-tests.mjs):
// no $TMUX, and plain `tmux` (from the code under test) resolving to that socket.
export const tmuxSandbox =
  !process.env.TMUX &&
  process.env.TMUX_TMPDIR &&
  process.env.FARMSLOT_TMUX_SANDBOX ===
    `${process.env.TMUX_TMPDIR}/tmux-${process.getuid?.() ?? 0}/default`
    ? process.env.FARMSLOT_TMUX_SANDBOX
    : null;
export const needsTmuxSandbox = {
  skip: !tmuxSandbox && 'needs the test runner tmux sandbox (FARMSLOT_TMUX_SANDBOX)',
};

const execFileAsync = promisify(execFile);

const realPrepareCommand = await import('../methods/slot/prepare-command.js');
mock.module('../methods/slot/prepare-command.js', {
  namedExports: {
    ...realPrepareCommand,
    runPrepareCommand: async (): Promise<ExecResult> => ({
      stdout: 'state-only dependency phase completed\n',
      stderr: '',
      exitCode: 0,
    }),
  },
});
const realFixtures = await import('../methods/slot/fixtures.js');
mock.module('../methods/slot/fixtures.js', {
  namedExports: { ...realFixtures, runFixtureSync: async () => undefined },
});

export const { slotPrepare } = await import('../methods/slot.js');

const gitEnv = ['-c', 'user.name=Farmslot Test', '-c', 'user.email=farmslot-test@example.invalid'];

export async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...gitEnv, ...args]);
  return stdout.trim();
}

/**
 * Origin holds main and an upstream PR branch pushed from another clone, the
 * way another slot or node publishes it. The slot itself has never seen that
 * branch: origin is the only way to reach it.
 */
export async function stackFixture(
  t: import('node:test').TestContext,
  label: string,
  port: number,
  options: { linkedWorktreeOn?: string } = {},
) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), `farmslot-stack-${label}-`));
  const originRepo = path.join(fixtureRoot, 'origin.git');
  const otherSlot = path.join(fixtureRoot, 'other-slot');
  const slotRepo = path.join(fixtureRoot, 'slot');
  const repoRoot = path.resolve(new URL('../../../../', import.meta.url).pathname);
  const slotId = `stack-${label}-${process.pid}`;
  const poolPath = path.join(repoRoot, 'pool', `${slotId}.json`);
  t.after(async () => {
    // Prepare's tmux phase opens a real session named after the slot.
    spawnSync('tmux', ['-S', tmuxSandbox!, 'kill-session', '-t', `=${slotId}`], {
      stdio: 'ignore',
    });
    assert.notEqual(
      spawnSync('tmux', ['-S', tmuxSandbox!, 'has-session', '-t', `=${slotId}`], {
        stdio: 'ignore',
      }).status,
      0,
      `tmux session ${slotId} must not outlive the test`,
    );
    await rm(poolPath, { force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', originRepo]);
  await execFileAsync('git', ['init', '--initial-branch=main', otherSlot]);
  await writeFile(path.join(otherSlot, 'README.md'), 'fixture\n');
  await git(otherSlot, 'add', 'README.md');
  await git(otherSlot, 'commit', '-m', 'fixture');
  await git(otherSlot, 'remote', 'add', 'origin', originRepo);
  await git(otherSlot, 'push', '--set-upstream', 'origin', 'main');
  const mainHead = await git(otherSlot, 'rev-parse', 'HEAD');
  if (options.linkedWorktreeOn) {
    // The slot is a linked worktree of another clone, still on the branch a
    // previous run used, with a published stale commit of its own.
    const primary = path.join(fixtureRoot, 'primary');
    await execFileAsync('git', ['clone', originRepo, primary]);
    await git(primary, 'worktree', 'add', '-b', options.linkedWorktreeOn, slotRepo, 'origin/main');
    await writeFile(path.join(slotRepo, 'stale.txt'), 'stale\n');
    await git(slotRepo, 'add', 'stale.txt');
    await git(slotRepo, 'commit', '-m', 'stale work from an earlier run');
    await git(slotRepo, 'push', 'origin', options.linkedWorktreeOn);
  } else {
    await execFileAsync('git', ['clone', originRepo, slotRepo]);
  }
  await git(otherSlot, 'checkout', '-b', 'feat/upstream');
  await writeFile(path.join(otherSlot, 'upstream.txt'), 'upstream work\n');
  await git(otherSlot, 'add', 'upstream.txt');
  await git(otherSlot, 'commit', '-m', 'upstream work');
  await git(otherSlot, 'push', 'origin', 'feat/upstream');
  const upstreamHead = await git(otherSlot, 'rev-parse', 'HEAD');
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
            resources: { 'dev-server': { port, metro_port: port + 70 } },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { slotId, slotRepo, mainHead, upstreamHead };
}
