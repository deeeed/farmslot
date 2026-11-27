import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { ExecResult } from '@farmslot/protocol';

import '../core/hermetic-git.test-support.js';
import '../core/private-pool.test-support.js';

import { poolDirectory } from '../core/config.js';
import { claimSlotStatusIf } from '../core/state.js';

// 942d189f / 1f5bfba9 shape: a replayed run's local-only work branch had no
// commits of its own and still sat at the old base, before audiolab #532 sorted
// scripts/agentic/package.json. Prepare reused it there, Yarn re-sorted the
// manifest and the tracked-file check stopped every replay until someone moved
// the branch by hand. An empty work branch now starts from the current base; a
// branch with its own commits stays where it is.
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
const manifestPath = 'scripts/agentic/package.json';
const unsortedManifest = `${JSON.stringify(
  {
    name: '@siteed/audiolab-agentic',
    private: true,
    dependencies: {
      '@farmslot/adapter-sdk': '0.25.2',
      '@farmslot/recipe-cli': '0.32.1',
      pngjs: '^7.0.0',
      '@farmslot/adapter-rn': '0.29.2',
    },
  },
  null,
  2,
)}\n`;

// Stands in for `yarn install --immutable`: rewrites the workspace manifest with
// dependencies sorted, as Yarn's manifest persistence does.
const yarnPersist = `node -e '
const fs = require("fs");
const file = ${JSON.stringify(manifestPath)};
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\\n");
'`;

const commands: string[] = [];
const realPrepareCommand = await import('../methods/slot/prepare-command.js');
mock.module('../methods/slot/prepare-command.js', {
  namedExports: {
    ...realPrepareCommand,
    runPrepareCommand: async (
      vars: { remoteRepo: string },
      _logPath: string,
      command: string,
    ): Promise<ExecResult> => {
      commands.push(command);
      if (!command.includes('yarn install')) return { stdout: '', stderr: '', exitCode: 0 };
      const r = spawnSync('bash', ['-c', yarnPersist], { cwd: vars.remoteRepo, encoding: 'utf8' });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
    },
  },
});

const realFixtures = await import('../methods/slot/fixtures.js');
mock.module('../methods/slot/fixtures.js', {
  namedExports: { ...realFixtures, runFixtureSync: async () => undefined },
});

// Lets a test switch the slot to another branch around a guarded command.
let beforeMove: (() => void) | undefined;
let afterCheckout: (() => void) | undefined;
const realMutations = await import('../run-lifecycle/validation-run-commits.js');
mock.module('../run-lifecycle/validation-run-commits.js', {
  namedExports: {
    ...realMutations,
    slotGitMutations: (...args: Parameters<typeof realMutations.slotGitMutations>) => {
      const guarded = realMutations.slotGitMutations(...args);
      return async (command: string, targetTrees?: string[]) => {
        if (beforeMove && command.includes('reset --keep')) {
          beforeMove();
          beforeMove = undefined;
        }
        const result = await guarded(command, targetTrees);
        if (afterCheckout && /git checkout '?fix\//.test(command)) {
          afterCheckout();
          afterCheckout = undefined;
        }
        return result;
      };
    },
  },
});

const { slotPrepare } = await import('../methods/slot.js');

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    ...args,
  ]);
  return stdout.trim();
}

let slotCounter = 0;

/**
 * origin/main moved from A (unsorted manifest) to B (sorted, the #532 fix) after
 * the run's branch was made; the slot still has origin/main at A.
 */
async function staleBaseSlot(t: { after: (fn: () => Promise<void>) => void }) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-replay-base-'));
  const slotRepo = path.join(fixtureRoot, 'slot');
  const originRepo = path.join(fixtureRoot, 'origin.git');
  const authorRepo = path.join(fixtureRoot, 'author');
  const index = slotCounter++;
  const slotId = `replay-base-${process.pid}-${index}`;
  const poolPath = path.join(poolDirectory(), `${slotId}.json`);
  t.after(async () => {
    const session = spawnSync('tmux', ['-S', tmuxSandbox!, 'has-session', '-t', `=${slotId}`]);
    if (session.status === 0)
      await execFileAsync('tmux', ['-S', tmuxSandbox!, 'kill-session', '-t', `=${slotId}`]);
    await rm(poolPath, { force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  await execFileAsync('git', ['init', '--initial-branch=main', slotRepo]);
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', originRepo]);
  await mkdir(path.join(slotRepo, 'scripts/agentic'), { recursive: true });
  await writeFile(path.join(slotRepo, manifestPath), unsortedManifest);
  await writeFile(path.join(slotRepo, 'README.md'), 'fixture\n');
  await git(slotRepo, 'add', '.');
  await git(slotRepo, 'commit', '-qm', 'A: unsorted agentic manifest');
  await git(slotRepo, 'remote', 'add', 'origin', originRepo);
  await git(slotRepo, 'push', '-q', '--set-upstream', 'origin', 'main');
  const oldBase = await git(slotRepo, 'rev-parse', 'HEAD');
  await execFileAsync('git', ['clone', '-q', originRepo, authorRepo]);
  spawnSync('bash', ['-c', yarnPersist], { cwd: authorRepo });
  await git(authorRepo, 'commit', '-qam', 'B: sort agentic dependencies');
  await git(authorRepo, 'push', '-q', 'origin', 'main');
  const newBase = await git(authorRepo, 'rev-parse', 'HEAD');
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
          resources: { 'dev-server': { port: 48830 + index, metro_port: 48930 + index } },
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
  return { slotId, slotRepo, oldBase, newBase };
}

const workBranch = 'fix/505-bug-ios-ignores-preferrawstrea';

function stepsOf(events: Array<{ event: string; payload: unknown }>): string[] {
  return events
    .filter(({ event }) => event === 'slot.prepare.step')
    .map(({ payload }) => (payload as { detail: string }).detail);
}

test('a replay starts an empty work branch from the current base', needsTmuxSandbox, async (t) => {
  const { slotId, slotRepo, oldBase, newBase } = await staleBaseSlot(t);
  await git(slotRepo, 'branch', workBranch, oldBase);
  // Merge configuration must not change the move (it is not a merge).
  await git(slotRepo, 'config', `branch.${workBranch}.mergeOptions`, '--squash');
  await git(slotRepo, 'config', 'merge.autoStash', 'true');
  const events: Array<{ event: string; payload: unknown }> = [];
  const result = await slotPrepare(
    { slotId, branch: workBranch, prepareProfile: 'core' },
    (event, payload) => events.push({ event, payload }),
    undefined,
    { preserveBranch: true },
  );
  assert.equal(result.prepared, true);
  assert.equal(await git(slotRepo, 'branch', '--show-current'), workBranch);
  assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), newBase);
  assert.equal(await git(slotRepo, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.ok(
    stepsOf(events).some((detail) =>
      detail.startsWith(
        `${workBranch} had no commits beyond origin/main; fast-forwarded from ${oldBase.slice(0, 12)}`,
      ),
    ),
  );
});

test(
  'a fresh prepare starts an existing empty local work branch from the current base',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, oldBase, newBase } = await staleBaseSlot(t);
    await git(slotRepo, 'branch', workBranch, oldBase);
    const result = await slotPrepare(
      { slotId, branch: workBranch, prepareProfile: 'core' },
      () => {},
    );
    assert.equal(result.prepared, true);
    assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), newBase);
    assert.equal(await git(slotRepo, 'status', '--porcelain', '--untracked-files=no'), '');
  },
);

test(
  'a checked-out empty branch fast-forwards on replay and keeps uncommitted work',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, oldBase, newBase } = await staleBaseSlot(t);
    await git(slotRepo, 'checkout', '-q', '-b', workBranch, oldBase);
    await writeFile(path.join(slotRepo, 'README.md'), 'uncommitted work\n');
    const result = await slotPrepare(
      { slotId, branch: workBranch, prepareProfile: 'core' },
      () => {},
      undefined,
      { preserveBranch: true },
    );
    assert.equal(result.prepared, true);
    assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), newBase);
    assert.equal(await readFile(path.join(slotRepo, 'README.md'), 'utf8'), 'uncommitted work\n');
  },
);

test('a work branch with its own commits keeps its base on replay', needsTmuxSandbox, async (t) => {
  const { slotId, slotRepo, oldBase, newBase } = await staleBaseSlot(t);
  await git(slotRepo, 'checkout', '-q', '-b', workBranch, oldBase);
  // The run's own commit (its manifest already sorted, so deps changes nothing).
  spawnSync('bash', ['-c', yarnPersist], { cwd: slotRepo });
  await writeFile(path.join(slotRepo, 'fix.txt'), 'the fix\n');
  await git(slotRepo, 'add', '.');
  await git(slotRepo, 'commit', '-qm', 'fix: the run work');
  const tip = await git(slotRepo, 'rev-parse', 'HEAD');
  await git(slotRepo, 'checkout', '-q', 'main');
  const result = await slotPrepare(
    { slotId, branch: workBranch, prepareProfile: 'core' },
    () => {},
    undefined,
    { preserveBranch: true },
  );
  assert.equal(result.prepared, true);
  assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), tip);
  await assert.rejects(git(slotRepo, 'merge-base', '--is-ancestor', newBase, 'HEAD'));
});

test('a published empty branch keeps its base on replay', needsTmuxSandbox, async (t) => {
  const { slotId, slotRepo, oldBase } = await staleBaseSlot(t);
  await git(slotRepo, 'branch', workBranch, oldBase);
  await git(slotRepo, 'push', '-q', 'origin', workBranch);
  await assert.rejects(
    slotPrepare({ slotId, branch: workBranch, prepareProfile: 'core' }, () => {}, undefined, {
      preserveBranch: true,
    }),
    /prepare deps changed 1 tracked file/,
  );
  assert.equal(await git(slotRepo, 'rev-parse', `refs/heads/${workBranch}`), oldBase);
});

test(
  'local edits that conflict with the new base leave the branch where it was',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, oldBase } = await staleBaseSlot(t);
    await git(slotRepo, 'checkout', '-q', '-b', workBranch, oldBase);
    // autoStash would fast-forward and then fail to reapply the edit.
    await git(slotRepo, 'config', 'merge.autoStash', 'true');
    await writeFile(
      path.join(slotRepo, manifestPath),
      unsortedManifest.replace('"0.29.2"', '"0.29.3-local"'),
    );
    const events: Array<{ event: string; payload: unknown }> = [];
    await Promise.allSettled([
      slotPrepare(
        { slotId, branch: workBranch, prepareProfile: 'core' },
        (event, payload) => events.push({ event, payload }),
        undefined,
        { preserveBranch: true },
      ),
    ]);
    assert.equal(await git(slotRepo, 'rev-parse', `refs/heads/${workBranch}`), oldBase);
    assert.match(await readFile(path.join(slotRepo, manifestPath), 'utf8'), /0\.29\.3-local/);
    assert.ok(
      stepsOf(events).some((detail) =>
        detail.startsWith(`${workBranch} has no commits beyond origin/main but stays at`),
      ),
    );
  },
);

test(
  'an ignored local file the new base would track leaves the branch where it was',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, oldBase } = await staleBaseSlot(t);
    // origin/main gains a tracked path that the slot has as an ignored local file.
    const author = path.join(path.dirname(slotRepo), 'author');
    await writeFile(path.join(author, 'local.env'), 'tracked default\n');
    await git(author, 'add', 'local.env');
    await git(author, 'commit', '-qm', 'C: track local.env');
    await git(author, 'push', '-q', 'origin', 'main');
    await git(slotRepo, 'checkout', '-q', '-b', workBranch, oldBase);
    await writeFile(path.join(slotRepo, '.git/info/exclude'), 'local.env\n');
    await writeFile(path.join(slotRepo, 'local.env'), 'operator secret\n');
    await Promise.allSettled([
      slotPrepare({ slotId, branch: workBranch, prepareProfile: 'core' }, () => {}, undefined, {
        preserveBranch: true,
      }),
    ]);
    assert.equal(await git(slotRepo, 'rev-parse', `refs/heads/${workBranch}`), oldBase);
    assert.equal(await readFile(path.join(slotRepo, 'local.env'), 'utf8'), 'operator secret\n');
  },
);

test('a staged edit keeps the branch where it was', needsTmuxSandbox, async (t) => {
  const { slotId, slotRepo, oldBase } = await staleBaseSlot(t);
  await git(slotRepo, 'checkout', '-q', '-b', workBranch, oldBase);
  await writeFile(path.join(slotRepo, 'README.md'), 'staged work\n');
  await git(slotRepo, 'add', 'README.md');
  await writeFile(path.join(slotRepo, 'README.md'), 'fixture\n');
  await Promise.allSettled([
    slotPrepare({ slotId, branch: workBranch, prepareProfile: 'core' }, () => {}, undefined, {
      preserveBranch: true,
    }),
  ]);
  assert.equal(await git(slotRepo, 'rev-parse', `refs/heads/${workBranch}`), oldBase);
  assert.equal(await git(slotRepo, 'show', ':README.md'), 'staged work');
});

test('a failing added-path scan keeps the branch where it was', needsTmuxSandbox, async (t) => {
  const { slotId, slotRepo, oldBase } = await staleBaseSlot(t);
  await git(slotRepo, 'branch', workBranch, oldBase);
  // `git diff` exits 128 with a missing order file; the move must refuse, not read it as clear.
  await git(slotRepo, 'config', 'diff.orderFile', '/nonexistent/farmslot-order-file');
  await Promise.allSettled([
    slotPrepare({ slotId, branch: workBranch, prepareProfile: 'core' }, () => {}, undefined, {
      preserveBranch: true,
    }),
  ]);
  assert.equal(await git(slotRepo, 'rev-parse', `refs/heads/${workBranch}`), oldBase);
});

test(
  'a tracked directory the new base turns into a file still moves the branch',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, oldBase } = await staleBaseSlot(t);
    // Old tip: tools/run/old.sh tracked. New base (on top of the #532 fix): tools/run is a file.
    const author = path.join(path.dirname(slotRepo), 'author');
    await git(author, 'checkout', '-q', 'main');
    await mkdir(path.join(slotRepo, 'tools/run'), { recursive: true });
    await writeFile(path.join(slotRepo, 'tools/run/old.sh'), 'old\n');
    await git(slotRepo, 'checkout', '-q', '-b', workBranch, oldBase);
    await git(slotRepo, 'add', 'tools/run/old.sh');
    await git(slotRepo, 'commit', '-qm', 'A2: tools/run directory');
    const dirTip = await git(slotRepo, 'rev-parse', 'HEAD');
    await git(slotRepo, 'push', '-q', 'origin', `${dirTip}:refs/heads/main`, '--force');
    await git(author, 'fetch', '-q', 'origin');
    await git(author, 'reset', '-q', '--hard', 'origin/main');
    spawnSync('bash', ['-c', yarnPersist], { cwd: author });
    await git(author, 'rm', '-q', '-r', 'tools/run');
    await mkdir(path.join(author, 'tools'), { recursive: true });
    await writeFile(path.join(author, 'tools/run'), 'now a file\n');
    await git(author, 'add', '-A');
    await git(author, 'commit', '-qm', 'B2: sorted manifest, tools/run is a file');
    await git(author, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const fileBase = await git(author, 'rev-parse', 'HEAD');
    const result = await slotPrepare(
      { slotId, branch: workBranch, prepareProfile: 'core' },
      () => {},
      undefined,
      { preserveBranch: true },
    );
    assert.equal(result.prepared, true);
    assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), fileBase);
    assert.equal(await readFile(path.join(slotRepo, 'tools/run'), 'utf8'), 'now a file\n');
  },
);

test(
  'an ignored local file where the new base needs a directory leaves the branch where it was',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, oldBase } = await staleBaseSlot(t);
    const author = path.join(path.dirname(slotRepo), 'author');
    await mkdir(path.join(author, 'tools/run'), { recursive: true });
    await writeFile(path.join(author, 'tools/run/command'), 'tracked\n');
    await git(author, 'add', 'tools/run/command');
    await git(author, 'commit', '-qm', 'C: add tools/run/command');
    await git(author, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    await git(slotRepo, 'checkout', '-q', '-b', workBranch, oldBase);
    await writeFile(path.join(slotRepo, '.git/info/exclude'), 'tools/run\n');
    await mkdir(path.join(slotRepo, 'tools'), { recursive: true });
    await writeFile(path.join(slotRepo, 'tools/run'), 'operator file\n');
    await Promise.allSettled([
      slotPrepare({ slotId, branch: workBranch, prepareProfile: 'core' }, () => {}, undefined, {
        preserveBranch: true,
      }),
    ]);
    assert.equal(await git(slotRepo, 'rev-parse', `refs/heads/${workBranch}`), oldBase);
    assert.equal(await readFile(path.join(slotRepo, 'tools/run'), 'utf8'), 'operator file\n');
  },
);

test(
  'a tracked symlink the new base turns into a directory loses nothing',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, oldBase } = await staleBaseSlot(t);
    const author = path.join(path.dirname(slotRepo), 'author');
    // Old tip: tools/run -> ../shared (tracked symlink) and shared/command (tracked file).
    await git(slotRepo, 'checkout', '-q', '-b', workBranch, oldBase);
    await mkdir(path.join(slotRepo, 'tools'), { recursive: true });
    await mkdir(path.join(slotRepo, 'shared'), { recursive: true });
    await writeFile(path.join(slotRepo, 'shared/command'), 'shared\n');
    await symlink('../shared', path.join(slotRepo, 'tools/run'));
    await git(slotRepo, 'add', 'tools/run', 'shared/command');
    await git(slotRepo, 'commit', '-qm', 'A2: tools/run symlink');
    const linkTip = await git(slotRepo, 'rev-parse', 'HEAD');
    await git(slotRepo, 'push', '-q', 'origin', `${linkTip}:refs/heads/main`, '--force');
    // New base: sorted manifest, tools/run becomes a directory holding command.
    await git(author, 'fetch', '-q', 'origin');
    await git(author, 'reset', '-q', '--hard', 'origin/main');
    spawnSync('bash', ['-c', yarnPersist], { cwd: author });
    await git(author, 'rm', '-q', 'tools/run');
    await mkdir(path.join(author, 'tools/run'), { recursive: true });
    await writeFile(path.join(author, 'tools/run/command'), 'own\n');
    await git(author, 'add', '-A');
    await git(author, 'commit', '-qm', 'B2: tools/run is a directory');
    await git(author, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const dirBase = await git(author, 'rev-parse', 'HEAD');
    // The scan does not probe beneath the tracked symlink; the parked-work guard then refuses
    // pathspecs beyond a symlink, so prepare fails before any move and nothing local is touched.
    await assert.rejects(
      slotPrepare({ slotId, branch: workBranch, prepareProfile: 'core' }, () => {}, undefined, {
        preserveBranch: true,
      }),
      /beyond a symbolic link/,
    );
    assert.equal(await git(slotRepo, 'rev-parse', `refs/heads/${workBranch}`), linkTip);
    assert.notEqual(linkTip, dirBase);
    assert.equal(await readFile(path.join(slotRepo, 'shared/command'), 'utf8'), 'shared\n');
  },
);

test('a branch switch during the move stops prepare', needsTmuxSandbox, async (t) => {
  const { slotId, slotRepo, oldBase } = await staleBaseSlot(t);
  await git(slotRepo, 'branch', workBranch, oldBase);
  beforeMove = () =>
    execFileSync('git', ['-C', slotRepo, 'checkout', '-q', '-b', 'operator-branch']);
  await assert.rejects(
    slotPrepare({ slotId, branch: workBranch, prepareProfile: 'core' }, () => {}, undefined, {
      preserveBranch: true,
    }),
    /changed while prepare was moving it/,
  );
  assert.equal(await git(slotRepo, 'rev-parse', `refs/heads/${workBranch}`), oldBase);
  assert.equal(await git(slotRepo, 'branch', '--show-current'), 'operator-branch');
});

test(
  'a branch switch right after the replay checkout stops prepare',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, oldBase } = await staleBaseSlot(t);
    await git(slotRepo, 'branch', workBranch, oldBase);
    afterCheckout = () =>
      execFileSync('git', ['-C', slotRepo, 'checkout', '-q', '-b', 'operator-branch']);
    await assert.rejects(
      slotPrepare({ slotId, branch: workBranch, prepareProfile: 'core' }, () => {}, undefined, {
        preserveBranch: true,
      }),
      /is not on fix\/505-bug-ios-ignores-preferrawstrea after checkout/,
    );
    assert.equal(await git(slotRepo, 'branch', '--show-current'), 'operator-branch');
    assert.equal(await git(slotRepo, 'rev-parse', `refs/heads/${workBranch}`), oldBase);
  },
);
