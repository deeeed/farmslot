// @farmslot:serial — isolated process owns module fixtures and the revision publisher.
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { Methods } from '@farmslot/protocol';
import { type ResourceKey, resourceKeyId, resourceQuery } from '@farmslot/protocol/client-cache';
import type { ResourceChangedPayload } from '@farmslot/protocol/transport/events';

// Must load before production modules: pty-stream has import-time tmux effects.
// Also rejects tmux in child_process exec/spawn, including absolute paths/shell snippets.
import '../runtime/mock-pty.test-support.js';

import { makeVars } from '../runners/test-fixtures.js';

// Preserve the parent environment; all commands below run only inside temporary repos.
const inheritedGit = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith('GIT_')),
);
for (const key of Object.keys(inheritedGit)) delete process.env[key];
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
after(() => {
  for (const key of Object.keys(process.env).filter((key) => key.startsWith('GIT_')))
    delete process.env[key];
  Object.assign(process.env, inheritedGit);
});

interface Fixture {
  home: string;
  repo: string;
  other: string;
  slotId: string;
  otherSlotId: string;
  runId: string;
  branch: string;
}
let fixture: Fixture | undefined;
let execution!: typeof import('../core/exec.js');
const local = (host: string) => host === 'localhost';
const loadVars = async (slotId: string) => {
  assert(fixture, 'No active owned fixture');
  assert([fixture.slotId, fixture.otherSlotId].includes(slotId), 'Never resolve a real farm slot');
  const repo = slotId === fixture.slotId ? fixture.repo : fixture.other;
  return makeVars({
    slotId,
    repo,
    remoteRepo: repo,
    host: 'localhost',
    machine: 'local',
    projectName: '',
  });
};
// Mock only config/inventory discovery and unrelated artifact/review dependencies.
// Execution, methods, recursive file source, branch watcher, admission and publisher stay real.
mock.module('../core/config.js', { namedExports: { loadSlotVars: loadVars } });
mock.module('../core/index.js', {
  namedExports: {
    loadSlotVars: loadVars,
    isLocal: local,
    execArgvOnSlot: (...args: Parameters<typeof execution.execArgvOnSlot>) =>
      execution.execArgvOnSlot(...args),
    farmslotRoot: '/',
    getProjectFieldRaw: () => assert.fail('Project config is outside this fixture'),
  },
});
mock.module('../fleet/state.js', {
  namedExports: {
    loadPoolConfigs: async () => {
      assert(fixture);
      return [
        {
          host: 'localhost',
          machine: 'local',
          slots: [
            { id: fixture.slotId, repo: fixture.repo },
            { id: fixture.otherSlotId, repo: fixture.other },
          ],
        },
      ];
    },
    loadFleetStatus: async () => {
      assert(fixture);
      return {
        slots: [
          {
            slot: fixture.slotId,
            enabled: true,
            machine: 'local',
            branch: fixture.branch,
            currentRunId: fixture.runId,
          },
          { slot: fixture.otherSlotId, enabled: true, machine: 'local' },
        ],
      };
    },
  },
});
mock.module('../runs/store.js', {
  namedExports: {
    getRun: (id: string) => {
      assert.equal(id, fixture?.runId);
      return { id, engineState: { generation: 'owned-fixture-generation' } };
    },
    getRunWithArchived: () => assert.fail('No retained review read in writer test'),
  },
});
mock.module('../live-recipe/context.js', {
  namedExports: { invalidateArtifactTextCache: () => {} },
});
mock.module('../review-workspaces/git.js', {
  namedExports: {
    workspaceReviewGit: () => assert.fail('No review backend in writer test'),
  },
});
mock.module('../run-engine/project-vars.js', {
  namedExports: { loadProjectVarsOrNull: async () => null },
});

execution = await import('../core/exec.js');
const fsMethods = await import('../methods/filesystem.js');
const gitMethods = await import('../methods/git.js');
const { captureWorkspaceRead, runWorkspaceObservedRead } = await import('./workspace-read.js');
const { workspaceObservations, workspaceSourceId } = await import('./workspace-observations.js');
const { resourceRevisions, readWithResourceState } = await import('./revisions.js');
const branchOwner = await import('../automation/branch-watcher.js');
const branchEvents: Array<{ slotId: string; branch: string }> = [];
branchOwner.onBranchChange((slotId, branch) => {
  branchEvents.push({ slotId, branch });
});
const execute = promisify(execFileCallback);
const git = (cwd: string, ...args: string[]) =>
  execute(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Writer Fixture',
      '-c',
      'user.email=writer@example.invalid',
      ...args,
    ],
    { cwd, timeout: 3000 },
  );

async function temporary(t: TestContext, linked = false): Promise<Fixture> {
  assert.equal(fixture, undefined);
  // Source ownership uses canonical paths, including macOS /var -> /private/var.
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'gateway-writer-publication-')));
  const f = {
    home,
    repo: path.join(home, 'repo'),
    other: path.join(home, 'unrelated'),
    slotId: path.basename(home),
    otherSlotId: `${path.basename(home)}-unrelated`,
    runId: `${path.basename(home)}-run`,
    branch: linked ? 'slot-base' : 'main',
  };
  fixture = f;
  // Register teardown before setup or arming can fail. Stop owners before removing roots.
  t.after(async () => {
    try {
      await branchOwner.stopAllBranchWatches();
      workspaceObservations.release(workspaceSourceId('local', f.repo));
      workspaceObservations.release(workspaceSourceId('local', f.other));
    } finally {
      resourceRevisions.dispose();
      resourceRevisions.setPublisher(() => {});
      fixture = undefined;
      await rm(home, { recursive: true, force: true });
    }
  });
  const main = linked ? path.join(home, 'main') : f.repo;
  await mkdir(main);
  await mkdir(f.other);
  await git(main, 'init', '-b', 'main');
  await git(main, 'config', 'core.hooksPath', '/dev/null');
  await writeFile(path.join(main, 'tracked.txt'), 'base\n');
  await git(main, 'add', '--', 'tracked.txt');
  await git(main, 'commit', '-m', 'base');
  await git(main, 'commit', '--allow-empty', '-m', 'second');
  if (linked) await git(main, 'worktree', 'add', '-b', 'slot-base', f.repo);
  return f;
}
async function until(label: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2200;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(label);
}
async function openWorkspace(f: Fixture) {
  const plain = resourceQuery(Methods.FS_LIST, { slotId: f.slotId, path: '.' });
  const pinned = resourceQuery(Methods.GIT_STATUS, { slotId: f.slotId, runId: f.runId });
  const unrelated = resourceQuery(Methods.FS_LIST, { slotId: f.otherSlotId, path: '.' });
  for (const query of [plain, pinned, unrelated]) {
    const check = await captureWorkspaceRead(query.params as Record<string, unknown>, [
      ...query.dependencies,
    ]);
    await check();
  }
  return {
    plain,
    pinned,
    unrelated,
    keys: [...plain.dependencies, ...pinned.dependencies].filter(
      (key): key is ResourceKey => key.family === 'workspace',
    ),
  };
}
const cases = [
  {
    name: 'fs.write creates opened bytes',
    prepare: async (_f: Fixture) => {},
    mutate: (f: Fixture) =>
      fsMethods.fsWrite({ slotId: f.slotId, path: 'new.txt', content: 'created\n' }),
    verify: async (f: Fixture) =>
      assert.equal(
        (await fsMethods.fsRead({ slotId: f.slotId, path: 'new.txt' })).content,
        'created\n',
      ),
  },
  {
    name: 'fs.write replaces opened bytes',
    prepare: async (_f: Fixture) => {},
    mutate: (f: Fixture) =>
      fsMethods.fsWrite({ slotId: f.slotId, path: 'tracked.txt', content: 'replacement\n' }),
    verify: async (f: Fixture) =>
      assert.equal(
        (await fsMethods.fsRead({ slotId: f.slotId, path: 'tracked.txt' })).content,
        'replacement\n',
      ),
  },
  {
    name: 'fs.rename changes the opened directory',
    prepare: async (_f: Fixture) => {},
    mutate: (f: Fixture) =>
      fsMethods.fsRename({ slotId: f.slotId, oldPath: 'tracked.txt', newPath: 'renamed.txt' }),
    verify: async (f: Fixture) => {
      const names = (await fsMethods.fsList({ slotId: f.slotId, path: '.' })).entries.map(
        (entry) => entry.name,
      );
      assert(names.includes('renamed.txt') && !names.includes('tracked.txt'));
    },
  },
  {
    name: 'fs.delete removes an opened nested tree',
    prepare: async (f: Fixture) => {
      await mkdir(path.join(f.repo, 'nested'));
      await writeFile(path.join(f.repo, 'nested/file'), 'delete\n');
    },
    mutate: (f: Fixture) => fsMethods.fsDelete({ slotId: f.slotId, path: 'nested' }),
    verify: async (f: Fixture) =>
      assert(
        !(await fsMethods.fsList({ slotId: f.slotId, path: '.' })).entries.some(
          (entry) => entry.name === 'nested',
        ),
      ),
  },
  {
    name: 'fs.mkdir creates an opened nested directory',
    prepare: async (_f: Fixture) => {},
    mutate: (f: Fixture) => fsMethods.fsMkdir({ slotId: f.slotId, path: 'created/nested' }),
    verify: async (f: Fixture) =>
      assert(
        (await fsMethods.fsList({ slotId: f.slotId, path: 'created' })).entries.some(
          (entry) => entry.name === 'nested' && entry.type === 'directory',
        ),
      ),
  },
  {
    name: 'git.stage changes the watched index',
    prepare: (f: Fixture) => writeFile(path.join(f.repo, 'tracked.txt'), 'stage\n'),
    mutate: (f: Fixture) => gitMethods.gitStage({ slotId: f.slotId, path: 'tracked.txt' }),
    verify: async (f: Fixture) =>
      assert(
        (await git(f.repo, '--no-optional-locks', 'diff', '--cached')).stdout.includes('+stage'),
      ),
  },
  {
    name: 'git.unstage changes only the watched index',
    prepare: async (f: Fixture) => {
      await writeFile(path.join(f.repo, 'tracked.txt'), 'unstage\n');
      await git(f.repo, 'add', 'tracked.txt');
    },
    mutate: (f: Fixture) => gitMethods.gitUnstage({ slotId: f.slotId, path: 'tracked.txt' }),
    verify: async (f: Fixture) => {
      assert.equal((await git(f.repo, '--no-optional-locks', 'diff', '--cached')).stdout, '');
      assert.equal(await readFile(path.join(f.repo, 'tracked.txt'), 'utf8'), 'unstage\n');
    },
  },
  {
    name: 'git.discard restores watched worktree bytes',
    prepare: (f: Fixture) => writeFile(path.join(f.repo, 'tracked.txt'), 'discard\n'),
    mutate: (f: Fixture) => gitMethods.gitDiscard({ slotId: f.slotId, path: 'tracked.txt' }),
    verify: async (f: Fixture) =>
      assert.equal(await readFile(path.join(f.repo, 'tracked.txt'), 'utf8'), 'base\n'),
  },
];
for (const scenario of cases)
  test(`owning writer publication: ${scenario.name}`, async (t) => {
    // Linked worktree makes index-only mutations observable only through external metadata coverage.
    const f = await temporary(t, true);
    await scenario.prepare(f);
    const queries = await openWorkspace(f);
    const packets: ResourceChangedPayload[] = [];
    resourceRevisions.setPublisher((packet) => packets.push(packet));
    const baseline = queries.keys.map((key) => resourceRevisions.revision(key));
    const checkBefore = await captureWorkspaceRead(
      queries.plain.params as Record<string, unknown>,
      [...queries.plain.dependencies],
    );
    assert.deepEqual(await scenario.mutate(f), { ok: true });
    await until('Owning source must publish both opened workspace aliases', () =>
      queries.keys.every((key, index) =>
        packets.some((packet) =>
          packet.changes.some(
            (change) =>
              resourceKeyId(change.key) === resourceKeyId(key) && change.revision > baseline[index],
          ),
        ),
      ),
    );
    await assert.rejects(checkBefore(), /changed during/);
    const expectedIds = new Set(queries.keys.map(resourceKeyId));
    assert.deepEqual(
      new Set(
        packets.flatMap((packet) => packet.changes).map((change) => resourceKeyId(change.key)),
      ),
      expectedIds,
    );
    for (const dependency of queries.unrelated.dependencies)
      assert.equal(resourceRevisions.revision(dependency), 0);
    // Side-effect verification uses actual readers/bytes, never a fabricated publisher receipt.
    await runWorkspaceObservedRead(() => scenario.verify(f));
    await until(
      'A fresh observed read must cover the source revision after notifications settle',
      async () => {
        try {
          const freshFence = await captureWorkspaceRead(
            queries.plain.params as Record<string, unknown>,
            [...queries.plain.dependencies],
          );
          const reread = await readWithResourceState([...queries.plain.dependencies], () =>
            runWorkspaceObservedRead(() => fsMethods.fsList({ slotId: f.slotId, path: '.' })),
          );
          await freshFence();
          assert(
            reread.resourceState.dependencies
              .filter((dep) => dep.key.family === 'workspace')
              .every((dep) => dep.revision > baseline[0]),
          );
          return true;
        } catch (error) {
          // A real late watcher callback invalidates that page. Only this source fence is retryable.
          if ((error as { code?: string }).code === 'RESOURCE_OBSERVATION_UNAVAILABLE')
            return false;
          throw error;
        }
      },
    );
  });

for (const detached of [false, true])
  test(`external HEAD publication: ${detached ? 'detached commit' : 'symbolic branch'} through branch owner`, async (t) => {
    const f = await temporary(t, true);
    const packets: ResourceChangedPayload[] = [];
    resourceRevisions.setPublisher((packet) => packets.push(packet));
    await branchOwner.watchBranch(f.slotId); // No startBranchWatchers and no remote polling timer.
    await Promise.resolve();
    const fleetKey = { family: 'slots', scope: 'farm' } as const;
    const slotKey = { family: 'slot', slotId: f.slotId } as const;
    const unrelatedKey = { family: 'slot', slotId: f.otherSlotId } as const;
    const baseline = [fleetKey, slotKey].map((key) => resourceRevisions.revision(key));
    const before = await branchOwner.assertBranchObservationsAdmitted(f.slotId);
    packets.length = 0;
    const expected = detached
      ? (await git(f.repo, 'rev-parse', '--short', 'HEAD~1')).stdout.trim()
      : 'external-proof-branch';
    await git(f.repo, 'checkout', ...(detached ? ['--detach', 'HEAD~1'] : ['-b', expected]));
    await until('External git checkout must pass the real HEAD watcher and branch emitter', () =>
      branchEvents.some((event) => event.slotId === f.slotId && event.branch === expected),
    );
    await until('External checkout must publish both branch projection keys', () =>
      [fleetKey, slotKey].every((key, index) =>
        packets.some((packet) =>
          packet.changes.some(
            (change) =>
              resourceKeyId(change.key) === resourceKeyId(key) && change.revision > baseline[index],
          ),
        ),
      ),
    );
    assert.throws(before, /changed during/);
    await until('Branch source must finish its actual projection read', async () => {
      try {
        const after = await branchOwner.assertBranchObservationsAdmitted(f.slotId);
        after();
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === 'RESOURCE_OBSERVATION_UNAVAILABLE') return false;
        throw error;
      }
    });
    assert.equal(resourceRevisions.revision(unrelatedKey), 0);
    assert.deepEqual(
      new Set(
        packets.flatMap((packet) => packet.changes).map((change) => resourceKeyId(change.key)),
      ),
      new Set([fleetKey, slotKey].map(resourceKeyId)),
    );
    assert.equal(
      (
        await git(
          f.repo,
          detached ? 'rev-parse' : 'branch',
          ...(detached ? ['--short', 'HEAD'] : ['--show-current']),
        )
      ).stdout.trim(),
      expected,
    );
  });
