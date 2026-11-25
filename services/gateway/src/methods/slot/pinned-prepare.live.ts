// Opt-in real Git prepare proof for pinned comparison runs; exceeds the default per-test budget.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { ExecResult } from '@farmslot/protocol';

import '../../core/hermetic-git.test-support.js';
import '../../core/private-pool.test-support.js';

import { poolDirectory } from '../../core/config.js';
import { claimSlotStatusIf } from '../../core/state.js';

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

// What the fake preflight does: it sees the command prepare built, and writes (or
// does not write) the receipt the project's real preflight would.
type Preflight = (command: string, runtimeDir: string) => Promise<ExecResult>;
let preflight: Preflight = async () => ({ stdout: '', stderr: '', exitCode: 0 });
const preflightCommands: string[] = [];
let projectConfigBroken = false;

const realPrepareCommand = await import('./prepare-command.js');
mock.module('./prepare-command.js', {
  namedExports: {
    ...realPrepareCommand,
    runPrepareCommand: async (
      vars: { remoteRepo: string },
      _log: string,
      command: string,
      options: { phase?: string },
    ): Promise<ExecResult> => {
      if (options.phase !== 'preflight') return { stdout: 'ok\n', stderr: '', exitCode: 0 };
      preflightCommands.push(command);
      return preflight(command, path.join(vars.remoteRepo, RUNTIME_DIR));
    },
  },
});
const realFixtures = await import('./fixtures.js');
mock.module('./fixtures.js', {
  namedExports: { ...realFixtures, runFixtureSync: async () => undefined },
});
const RUNTIME_DIR = '.agent';
const PINNED_PREPARE = {
  default: 'core-like',
  profiles: {
    'core-like': { phases: ['git'] },
    full: {
      phases: ['git', 'preflight'],
      pinned_kind: 'source',
      hooks: { preflight: 'true full' },
    },
    runway: {
      phases: ['git', 'preflight'],
      requires: ['artifact_available'],
      fallback: 'core-like',
      pinned_kind: 'runway',
      hooks: { preflight: 'true runway' },
    },
    'no-preflight': { phases: ['git'], pinned_kind: 'source' },
  },
  pinned_profiles: { cli: ['runway', 'full', 'no-preflight'] },
};
const realCore = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    loadProjectVars: async (name: string) => {
      if (projectConfigBroken) throw new Error('project.json: prepare.pinned_profiles is invalid');
      const real = await realCore.loadProjectVars(name);
      return {
        ...real,
        runtimeDir: RUNTIME_DIR,
        projectJson: {
          ...real.projectJson,
          // The probe would refuse; a pinned run must not consult it.
          hooks: { ...real.projectJson.hooks, artifact_check: 'exit 1' },
          prepare: PINNED_PREPARE,
        },
      };
    },
  },
});

const { slotPrepare } = await import('../slot.js');

const gitEnv = ['-c', 'user.name=Farmslot Test', '-c', 'user.email=farmslot-test@example.invalid'];
async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...gitEnv, ...args]);
  return stdout.trim();
}

/** A slot clone, and a base commit that only origin has, on branch `pinned-base`. */
async function pinnedFixture(t: import('node:test').TestContext, label: string, port: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), `farmslot-pinned-${label}-`));
  const origin = path.join(root, 'origin.git');
  const slotRepo = path.join(root, 'slot');
  const other = path.join(root, 'other');
  const slotId = `pinned-${label}-${process.pid}`;
  const poolPath = path.join(poolDirectory(), `${slotId}.json`);
  t.after(async () => {
    spawnSync('tmux', ['-S', tmuxSandbox!, 'kill-session', '-t', `=${slotId}`], {
      stdio: 'ignore',
    });
    await rm(poolPath, { force: true });
    await rm(root, { recursive: true, force: true });
  });
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', origin]);
  await execFileAsync('git', ['init', '--initial-branch=main', slotRepo]);
  await writeFile(path.join(slotRepo, 'README.md'), 'fixture\n');
  await writeFile(path.join(slotRepo, '.gitignore'), `${RUNTIME_DIR}/\n.sandbox/\n`);
  await git(slotRepo, 'add', '.');
  await git(slotRepo, 'commit', '-m', 'fixture');
  await git(slotRepo, 'remote', 'add', 'origin', origin);
  await git(slotRepo, 'push', '--set-upstream', 'origin', 'main');
  await execFileAsync('git', ['clone', origin, other]);
  await git(other, 'checkout', '-b', 'pinned-base');
  await writeFile(path.join(other, 'base.txt'), 'base\n');
  await git(other, 'add', 'base.txt');
  await git(other, 'commit', '-m', 'base');
  await git(other, 'push', 'origin', 'pinned-base');
  const baseSha = await git(other, 'rev-parse', 'HEAD');
  await assert.rejects(git(slotRepo, 'cat-file', '-e', baseSha), 'the slot clone lacks the base');
  await mkdir(path.join(slotRepo, RUNTIME_DIR), { recursive: true });
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
          resources: { 'dev-server': { port, metro_port: port + 70 } },
        },
      ],
    })}\n`,
  );
  await claimSlotStatusIf(slotId, () => true, {
    lifecycle: 'ready',
    phase: null,
    agent: 'idle',
    current_run_id: null,
  });
  return { slotId, slotRepo, baseSha };
}

const baseFrom = (command: string) =>
  /export FARMSLOT_PREPARE_BASE_SHA='?([0-9a-f]{40})'?/.exec(command)?.[1];

function writesReceipt(fields: Record<string, unknown>, exitCode = 0): Preflight {
  return async (command, runtimeDir) => {
    await writeFile(
      path.join(runtimeDir, 'prepare-artifact.json'),
      JSON.stringify({
        status: 'ok',
        kind: 'runway',
        baseSha: baseFrom(command),
        runId: '41900351233',
        revision: baseFrom(command),
        platform: 'cli',
        ...fields,
      }),
    );
    return { stdout: '', stderr: '', exitCode };
  };
}

const pinnedPrepare = (slotId: string, prepareProfile?: string) =>
  slotPrepare(
    {
      slotId,
      branch: 'pinned-work',
      flowType: 'dev',
      ...(prepareProfile ? { prepareProfile } : {}),
    },
    () => undefined,
    undefined,
    { startRef: { requestedRef: 'pinned-base' }, pinned: true },
  );

test(
  'a pinned preflight receives the resolved start commit and its receipt is the record',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, baseSha } = await pinnedFixture(t, 'base', 48830);
    preflightCommands.length = 0;
    preflight = writesReceipt({});
    const result = await pinnedPrepare(slotId);
    assert.equal(
      result.profile?.selected,
      'runway',
      'the artifact probe (exit 1) was not consulted',
    );
    assert.equal(
      baseFrom(preflightCommands[0] ?? ''),
      baseSha,
      'the 40-hex base, not the branch name',
    );
    assert.equal(result.startRef?.resolvedSha, baseSha);
    assert.equal(result.prepareArtifact?.kind, 'runway');
    assert.equal(result.prepareArtifact?.runId, '41900351233');
    assert.equal(result.prepareArtifact?.baseSha, baseSha);
    assert.equal(result.prepareArtifact?.revision, baseSha);
    assert.ok(result.prepareArtifact?.installedAt);
  },
);

test(
  'a pinned preflight that refuses the build fails prepare with the harness reason',
  needsTmuxSandbox,
  async (t) => {
    const { slotId } = await pinnedFixture(t, 'refused', 48832);
    preflight = writesReceipt(
      {
        status: 'failed',
        reason:
          'Runway run 43209905420 rejected: yarn.lock differs from the base commit\nNext: mm-harness launch ios --build',
      },
      1,
    );
    await assert.rejects(
      pinnedPrepare(slotId),
      /Pinned build refused: Runway run 43209905420 rejected: yarn\.lock differs from the base commit; Next: mm-harness launch ios --build — log: /,
    );
  },
);

test(
  'a pinned preflight that dies before its receipt reports its exit code and log',
  needsTmuxSandbox,
  async (t) => {
    const { slotId } = await pinnedFixture(t, 'died', 48834);
    preflight = async () => ({ stdout: '', stderr: '', exitCode: 3 });
    await assert.rejects(
      pinnedPrepare(slotId),
      /Preflight failed.*\(exit 3\).* — log: .*preflight\.log/,
    );
  },
);

test('a receipt left by an earlier prepare does not count', needsTmuxSandbox, async (t) => {
  const { slotId, slotRepo, baseSha } = await pinnedFixture(t, 'stale', 48836);
  await writeFile(
    path.join(slotRepo, RUNTIME_DIR, 'prepare-artifact.json'),
    JSON.stringify({
      status: 'ok',
      kind: 'runway',
      baseSha,
      runId: '1',
      revision: baseSha,
      platform: 'cli',
    }),
  );
  preflight = async () => ({ stdout: '', stderr: '', exitCode: 0 });
  await assert.rejects(pinnedPrepare(slotId), /wrote no prepare-artifact\.json/);
  await assert.rejects(readFile(path.join(slotRepo, RUNTIME_DIR, 'prepare-artifact.json')));
});

test('a pinned profile with no preflight fails prepare', needsTmuxSandbox, async (t) => {
  const { slotId } = await pinnedFixture(t, 'no-preflight', 48838);
  preflight = writesReceipt({ kind: 'source' });
  await assert.rejects(pinnedPrepare(slotId, 'no-preflight'), /wrote no prepare-artifact\.json/);
});

test(
  'a pinned run refuses an unlisted profile and a project config that fails to load',
  needsTmuxSandbox,
  async (t) => {
    const { slotId } = await pinnedFixture(t, 'refusals', 48840);
    preflight = writesReceipt({});
    await assert.rejects(
      pinnedPrepare(slotId, 'core-like'),
      /profile 'core-like': it is not in prepare\.pinned_profiles for cli/,
    );
    projectConfigBroken = true;
    try {
      await assert.rejects(pinnedPrepare(slotId), /config of project farmslot-farm failed to load/);
    } finally {
      projectConfigBroken = false;
    }
  },
);

test(
  'an unpinned prepare of the same run passes no base and needs no receipt',
  needsTmuxSandbox,
  async (t) => {
    const { slotId } = await pinnedFixture(t, 'unpinned', 48842);
    preflightCommands.length = 0;
    preflight = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const result = await slotPrepare(
      { slotId, branch: 'pinned-work', flowType: 'dev', prepareProfile: 'full' },
      () => undefined,
      undefined,
      { startRef: { requestedRef: 'pinned-base' } },
    );
    assert.equal(result.prepared, true);
    assert.equal(result.prepareArtifact, undefined);
    assert.equal(baseFrom(preflightCommands[0] ?? ''), undefined);
  },
);
