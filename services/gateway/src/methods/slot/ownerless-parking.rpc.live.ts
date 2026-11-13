// Opt-in authenticated RPC proof, real disposable Git repositories and fixtures; no farm run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  FleetRefreshSlotUpdateEvent,
  SlotParkedResult,
  SlotRefreshResult,
  SlotReleaseResult,
  SlotWorkspace,
} from '@farmslot/protocol';
import { isRecord } from '@farmslot/protocol/recipe';

import { createNativeProofFixture } from '../../runtime/native-proof-fixture.live-support.js';

const source = fileURLToPath(new URL('../../../../../', import.meta.url));
test(
  'releases retain ownerless backups and unpushed run branches across archive and retry',
  { timeout: 360_000 },
  async (t) => {
    const output = process.env.FARMSLOT_WORKSPACE_PROOF_OUT;
    assert.ok(output, 'set FARMSLOT_WORKSPACE_PROOF_OUT');
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(path.join(os.tmpdir(), 'ownerless-parking-'));
    for (const key of Object.keys(process.env))
      if (/^(FARMSLOT_|GIT_CONFIG)/.test(key) || key === 'TMUX' || key === 'TMUX_PANE')
        delete process.env[key];
    Object.assign(process.env, {
      NODE_TEST_CONTEXT: '1',
      GATEWAY_HOST: '127.0.0.1',
      FARMSLOT_HEAVY_WRITE_FLOOR_GB: '2',
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: path.join(root, 'home'),
      FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    });
    for (const name of ['home', 'pool', 'projects/proof/fixtures', 'seed', 'bin'])
      await mkdir(path.join(root, name), { recursive: true });
    for (const name of [
      'scripts',
      'packages',
      'services',
      'node_modules',
      'schemas',
      'package.json',
      'CLAUDE.md',
    ])
      await symlink(path.join(source, name), path.join(root, name));
    await writeFile(path.join(root, 'bin/tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.PATH = path.join(root, 'bin') + ':' + process.env.PATH;
    const seed = path.join(root, 'seed'),
      repo = path.join(root, 'checkout'),
      remote = path.join(root, 'remote.git');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    git(seed, 'init', '-q', '-b', 'main');
    for (const [key, value] of [
      ['user.name', 'Fixture'],
      ['user.email', 'fixture@example.invalid'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '/dev/null'],
    ])
      git(seed, 'config', key, value);
    await writeFile(path.join(seed, '.gitignore'), 'fixture.txt\n.agent/\n');
    await writeFile(path.join(seed, 'file.txt'), 'baseline\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'test: baseline');
    execFileSync('git', ['clone', '--bare', '-q', seed, remote]);
    execFileSync('git', ['clone', '-q', remote, repo]);
    for (const [key, value] of [
      ['user.name', 'Fixture'],
      ['user.email', 'fixture@example.invalid'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '/dev/null'],
    ])
      git(repo, 'config', key, value);
    await writeFile(path.join(root, 'projects/proof/fixtures/fixture.txt'), 'synced fixture\n');
    await writeFile(
      path.join(root, 'projects/proof/project.json'),
      JSON.stringify({
        name: 'proof',
        default_branch: 'main',
        hooks: {},
        fixtures: { templates: [{ src: 'fixture.txt', dst: 'fixture.txt' }] },
      }),
    );
    await writeFile(
      path.join(root, 'pool/local.json'),
      JSON.stringify({
        machine: os.hostname(),
        host: 'localhost',
        ssh_user: os.userInfo().username,
        project: 'proof',
        platform: 'cli',
        slots: [{ id: 'proof-slot', repo, session: 'ownerless-proof' }],
      }),
    );
    await writeFile(
      path.join(root, 'status.json'),
      JSON.stringify({
        checked_at: new Date().toISOString(),
        slots: [
          {
            slot: 'proof-slot',
            machine: os.hostname(),
            platform: 'cli',
            project: 'proof',
            ssh: 'LOCAL',
            dev: '-',
            devserver: '-',
            cdp: '-',
            fixtures: '0/1',
            branch: 'main',
            head_sha: git(repo, 'rev-parse', 'HEAD'),
            agent: 'idle',
            enabled: true,
            dispatchable: true,
            lifecycle: 'ready',
            phase: null,
            slot_epoch: 1,
            current_run_id: null,
            warm: false,
          },
        ],
      }),
    );
    await import('../../runtime/mock-pty.test-support.js');
    const execution = await import('../../core/exec.js');
    let moveAfterParkHead: string | undefined,
      movedDuringFetch: string | undefined,
      failParkFixtures = false;
    const execute: typeof execution.execOnSlot = async (...args) => {
      if (/\btmux\b/.test(args[1])) return { exitCode: 1, stdout: '', stderr: '' };
      if (
        moveAfterParkHead &&
        args[1].includes(' fetch origin ') &&
        git(repo, 'for-each-ref', '--format=%(objectname)', 'refs/farmslot/parked/')
          .split('\n')
          .includes(moveAfterParkHead)
      ) {
        moveAfterParkHead = undefined;
        git(repo, 'commit', '--allow-empty', '-qm', 'test: operator commits during reset fetch');
        movedDuringFetch = git(repo, 'rev-parse', 'HEAD');
      }
      return execution.execOnSlot(...args);
    };
    mock.module('../../core/exec.js', { namedExports: { ...execution, execOnSlot: execute } });
    const core = await import('../../core/index.js');
    mock.module('../../core/index.js', { namedExports: { ...core, execOnSlot: execute } });
    const tmux = await import('../../core/tmux.js');
    mock.module('../../core/tmux.js', {
      namedExports: { ...tmux, resolveTmuxSession: async () => 'ownerless-proof' },
    });
    const fixtures = await import('./fixtures.js');
    mock.module('./fixtures.js', {
      namedExports: {
        ...fixtures,
        slotFixtureRefresh: async (...args: Parameters<typeof fixtures.slotFixtureRefresh>) => {
          if (failParkFixtures) {
            failParkFixtures = false;
            throw new Error('Injected fixture failure after parking');
          }
          return fixtures.slotFixtureRefresh(...args);
        },
      },
    });
    const fixture = await createNativeProofFixture(t, root),
      connection = await fixture.client.connect();
    t.after(() => connection.close());
    const bulkUpdates: FleetRefreshSlotUpdateEvent[] = [],
      summaries = new Set<string>();
    connection.onEvent((event) => {
      if (event.event === 'fleet.refresh.slot-update')
        bulkUpdates.push(event.payload as FleetRefreshSlotUpdateEvent);
      if (
        event.event === 'fleet.refresh.summary' &&
        event.payload &&
        typeof event.payload === 'object' &&
        'requestId' in event.payload &&
        typeof event.payload.requestId === 'string'
      )
        summaries.add(event.payload.requestId);
    });
    const call = <T>(method: string, params?: unknown) =>
      connection.call<T>(method, params, { timeoutMs: 60_000 });
    const { inspectSlotWorkspace: inspectWorkspace } = await import('./workspace.js');
    git(repo, 'commit', '--allow-empty', '-qm', 'test: ownerless main work');
    const mainHead = git(repo, 'rev-parse', 'HEAD');
    const expectedWorkspace = await inspectWorkspace('proof-slot', {
      fetch: true,
      timeoutMs: 60_000,
    });
    const bulk = await call<{ requestId: string }>('fleet.refreshSlots', {
      requestId: 'ownerless-parking',
      slots: [{ slotId: 'proof-slot', release: true, mode: 'safe', expectedWorkspace }],
    });
    const deadline = Date.now() + 60_000;
    while (!summaries.has(bulk.requestId)) {
      assert.ok(Date.now() < deadline, 'bulk release completed');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const update = bulkUpdates.filter((item) => item.requestId === bulk.requestId).at(-1);
    assert.equal(update?.status, 'refreshed', JSON.stringify(update));
    assert.ok(update?.parked?.some((entry) => git(repo, 'rev-parse', entry.ref) === mainHead));
    assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/main'));
    const parkingCases: Array<{ name: string; result: SlotRefreshResult }> = [];
    const releaseOwnedProof = async (
      name: string,
      mode: 'safe' | 'force' = 'safe',
      observed?: SlotWorkspace,
    ) => {
      const expectedWorkspace =
        observed ??
        (await inspectWorkspace('proof-slot', {
          fetch: true,
          timeoutMs: 120_000,
        }));
      const result = await call<SlotRefreshResult>('slot.refresh', {
        slotId: 'proof-slot',
        release: true,
        mode,
        expectedWorkspace,
      });
      parkingCases.push({ name, result });
      return result;
    };
    const indexLock = path.join(repo, git(repo, 'rev-parse', '--git-path', 'index.lock'));
    await writeFile(indexLock, '');
    const oldLock = new Date(Date.now() - 60_000);
    await utimes(indexLock, oldLock, oldLock);
    const staleLockRelease = await releaseOwnedProof('stale-index-lock-safe-release');
    assert.equal(staleLockRelease.refreshed, true, staleLockRelease.detail);
    git(repo, 'update-index', '--refresh');

    const baselineHead = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '--allow-empty', '-qm', 'test: local default branch work');
    const localMainHead = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-qb', 'operator-feature', baselineHead);
    git(repo, 'commit', '--allow-empty', '-qm', 'test: feature work');
    const featureHead = git(repo, 'rev-parse', 'HEAD');
    const featurePark = await releaseOwnedProof('feature-and-local-main');
    assert.equal(featurePark.refreshed, true, featurePark.detail);
    for (const head of [featureHead, localMainHead])
      assert.ok(
        featurePark.parked?.some((entry) => git(repo, 'rev-parse', entry.ref) === head),
        'every overwritten head has a durable ref',
      );

    git(repo, 'checkout', '-qb', 'published-topic');
    git(repo, 'commit', '--allow-empty', '-qm', 'test: published topic');
    const topicHead = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'push', '-q', 'origin', 'HEAD:published-topic');
    git(repo, 'checkout', '-q', '--detach', topicHead);
    const detachedPark = await releaseOwnedProof('detached-published-head');
    assert.equal(detachedPark.refreshed, true, detachedPark.detail);
    assert.ok(
      detachedPark.parked?.some((entry) => git(repo, 'rev-parse', entry.ref) === topicHead),
    );

    git(repo, 'checkout', '-qb', 'copied-topic', topicHead);
    git(repo, 'push', '-q', 'origin', '--delete', 'published-topic');
    git(repo, 'update-ref', 'refs/remotes/origin/published-topic', topicHead);
    const copiedPark = await releaseOwnedProof('copied-head-with-stale-deleted-remote');
    assert.equal(copiedPark.refreshed, true, copiedPark.detail);
    assert.ok(copiedPark.parked?.some((entry) => git(repo, 'rev-parse', entry.ref) === topicHead));

    git(repo, 'commit', '--allow-empty', '-qm', 'test: dirty operator work');
    const dirtyHead = git(repo, 'rev-parse', 'HEAD');
    await writeFile(path.join(repo, 'file.txt'), 'uncommitted operator edit\n');
    const staleBeforeDirty = await inspectWorkspace('proof-slot', { network: false });
    await writeFile(path.join(repo, 'file.txt'), 'staged operator edit\n');
    git(repo, 'add', 'file.txt');
    await writeFile(path.join(repo, 'file.txt'), 'unstaged operator edit\n');
    await writeFile(path.join(repo, 'untracked.txt'), 'untracked operator edit\n');
    const dirtyPark = await releaseOwnedProof('dirty-safe-parking', 'safe', staleBeforeDirty);
    assert.equal(dirtyPark.refreshed, true, dirtyPark.detail);
    const inventory = await call<SlotParkedResult>('slot.parked', {
      action: 'list',
      slotId: 'proof-slot',
    });
    assert.equal(inventory.action, 'list');
    assert.ok(inventory.action === 'list');
    const dirtyReceipt = inventory.receipts.find(
      (receipt) => receipt.kind === 'worktree' && receipt.sourceHeadSha === dirtyHead,
    );
    assert.ok(dirtyReceipt, 'dirty work has a canonical, discoverable receipt');
    assert.equal(git(repo, 'status', '--porcelain'), '');
    git(repo, 'gc', '--prune=now');
    const restored = await call<SlotParkedResult>('slot.parked', {
      action: 'restore',
      slotId: 'proof-slot',
      ref: dirtyReceipt.ref,
    });
    assert.ok(restored.action === 'restore');
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), restored.branch);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), dirtyHead);
    assert.equal(git(repo, 'show', ':file.txt'), 'staged operator edit');
    assert.equal(await readFile(path.join(repo, 'file.txt'), 'utf8'), 'unstaged operator edit\n');
    assert.equal(
      await readFile(path.join(repo, 'untracked.txt'), 'utf8'),
      'untracked operator edit\n',
    );
    assert.ok((await core.readSlotRow('proof-slot'))?.parked_work);
    assert.equal(
      (await core.readSlotRow('proof-slot'))?.lifecycle,
      'ready',
      'restore preserves posture',
    );
    const restoredCleanup = await releaseOwnedProof('restored-dirty-reuse');
    assert.equal(restoredCleanup.refreshed, true, restoredCleanup.detail);
    await writeFile(
      path.join(output, 'restore.json'),
      JSON.stringify({ receipt: dirtyReceipt, restored, inventory: inventory.summary }, null, 2),
    );

    git(repo, 'checkout', '-qb', 'dirty-deletion-snapshot');
    await writeFile(path.join(repo, '.gitignore'), 'fixture.txt\n.agent/\ngenerated-note\n');
    await writeFile(path.join(repo, 'generated-note'), 'old generated content\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'add', '-f', 'generated-note');
    git(repo, 'commit', '-qm', 'test: tracked generated file');
    git(repo, 'rm', 'generated-note');
    const deletionPark = await releaseOwnedProof('dirty-deletion-snapshot');
    assert.equal(deletionPark.refreshed, true, deletionPark.detail);
    const deletionInventory = await call<SlotParkedResult>('slot.parked', {
      action: 'list',
      slotId: 'proof-slot',
    });
    assert.ok(deletionInventory.action === 'list');
    const deletionReceipt = deletionInventory.receipts.find(
      (receipt) => receipt.branch === 'dirty-deletion-snapshot' && receipt.kind === 'worktree',
    );
    assert.ok(deletionReceipt);
    await writeFile(path.join(repo, '.gitignore'), 'fixture.txt\n.agent/\ngenerated-note\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-qm', 'test: current ignore rules');
    await writeFile(path.join(repo, 'generated-note'), 'current ignored user content\n');
    const deletionRestore = await call<SlotParkedResult>('slot.parked', {
      action: 'restore',
      slotId: 'proof-slot',
      ref: deletionReceipt.ref,
    });
    assert.ok(deletionRestore.action === 'restore');
    const currentInventory = await call<SlotParkedResult>('slot.parked', {
      action: 'list',
      slotId: 'proof-slot',
    });
    assert.ok(currentInventory.action === 'list');
    const currentBackup = currentInventory.receipts.find(
      (receipt) =>
        receipt.kind === 'worktree' &&
        receipt.branch === 'main' &&
        git(repo, 'ls-tree', receipt.ref, 'generated-note'),
    );
    assert.ok(currentBackup, 'intermediate checkout must retain ignored current contents');
    assert.equal(
      git(repo, 'show', currentBackup.ref + ':generated-note'),
      'current ignored user content',
    );
    await writeFile(
      path.join(output, 'intermediate-restore.json'),
      JSON.stringify({ deletionReceipt, currentBackup, deletionRestore }, null, 2),
    );
    const deletionCleanup = await releaseOwnedProof('dirty-deletion-restored-cleanup');
    assert.equal(deletionCleanup.refreshed, true, deletionCleanup.detail);

    await writeFile(path.join(repo, 'legacy-refresh.txt'), 'ordinary refresh local work\n');
    const posture = (await core.readSlotRow('proof-slot'))?.warm;
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'commit', '--allow-empty', '-qm', 'test: remote main advanced');
    git(seed, 'push', '-q', 'origin', 'main');
    const remoteLock = path.join(
      repo,
      git(repo, 'rev-parse', '--git-path', 'refs/remotes/origin/main.lock'),
    );
    await writeFile(remoteLock, '');
    const oldRemoteLock = new Date(Date.now() - 60_000);
    await utimes(remoteLock, oldRemoteLock, oldRemoteLock);
    const ordinary = await call<SlotRefreshResult>('slot.refresh', {
      slotId: 'proof-slot',
      mode: 'safe',
    });
    assert.equal(ordinary.refreshed, true, ordinary.detail);
    assert.equal((await core.readSlotRow('proof-slot'))?.warm, posture);
    const ordinaryInventory = await call<SlotParkedResult>('slot.parked', {
      action: 'list',
      slotId: 'proof-slot',
    });
    assert.ok(ordinaryInventory.action === 'list');
    assert.ok(
      ordinaryInventory.receipts.some(
        (receipt) =>
          receipt.kind === 'worktree' && git(repo, 'ls-tree', receipt.ref, 'legacy-refresh.txt'),
      ),
    );
    assert.equal(git(repo, 'status', '--porcelain'), '');
    await writeFile(path.join(output, 'ordinary-refresh.json'), JSON.stringify(ordinary, null, 2));

    git(repo, 'commit', '--allow-empty', '-qm', 'test: parked before fixture failure');
    const failedHead = git(repo, 'rev-parse', 'HEAD');
    failParkFixtures = true;
    const parkedFailure = await releaseOwnedProof('parked-fixture-failure');
    assert.equal(parkedFailure.refreshed, false);
    assert.ok(
      parkedFailure.parked?.some((entry) => git(repo, 'rev-parse', entry.ref) === failedHead),
    );
    const durableFailure = await core.readSlotRow('proof-slot');
    assert.ok(durableFailure?.workspace_recovery);
    const disk: unknown = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8'));
    assert.ok(isRecord(disk) && Array.isArray(disk.slots));
    const diskRow: unknown = disk.slots.find(
      (item: unknown) => isRecord(item) && item.slot === 'proof-slot',
    );
    assert.ok(isRecord(diskRow));
    const { recoveryFromRow } = await import('./workspace.js');
    assert.ok(
      recoveryFromRow(diskRow)?.parked?.some(
        (entry) => git(repo, 'rev-parse', entry.ref) === failedHead,
      ),
      'the on-disk marker retains the backup',
    );
    const retriedPark = await releaseOwnedProof('parked-fixture-retry');
    assert.equal(retriedPark.refreshed, true, retriedPark.detail);
    assert.ok(
      retriedPark.parked?.some((entry) => git(repo, 'rev-parse', entry.ref) === failedHead),
    );

    git(repo, 'commit', '--allow-empty', '-qm', 'test: park before racing fetch');
    moveAfterParkHead = git(repo, 'rev-parse', 'HEAD');
    const racingPark = await releaseOwnedProof('head-moved-during-fetch');
    assert.equal(racingPark.refreshed, false);
    assert.ok(movedDuringFetch);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), movedDuringFetch);
    const raceRetry = await releaseOwnedProof('head-moved-retry');
    assert.equal(raceRetry.refreshed, true, raceRetry.detail);
    assert.ok(
      raceRetry.parked?.some((entry) => git(repo, 'rev-parse', entry.ref) === movedDuringFetch),
    );
    // Run-owned cleanup also keeps the original branch available to a new run.
    const { createRun, getRunWithArchived, updateRun } = await import('../../runs/store.js');
    const runBranches = [];
    for (const scenario of [
      { status: 'cancelled', inheritedBaseline: true },
      { status: 'cancelled', inheritedBaseline: false },
      { status: 'failed', inheritedBaseline: false },
    ] as const) {
      const { status, inheritedBaseline } = scenario;
      const branch = `proof-${status}${inheritedBaseline ? '-inherited' : ''}`;
      git(repo, 'checkout', '-qb', branch, 'origin/main');
      const base = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'commit', '--allow-empty', '-qm', 'test: unpublished one');
      git(repo, 'commit', '--allow-empty', '-qm', 'test: unpublished two');
      const head = git(repo, 'rev-parse', 'HEAD');
      const run = createRun({
        flowType: 'dev',
        project: 'proof',
        ticketOrPr: branch,
        slotId: 'proof-slot',
      });
      updateRun(run.id, {
        status,
        branch,
        worktreeHeadAtDispatch: inheritedBaseline ? head : base,
        completedAt: new Date().toISOString(),
      });
      const bind = async (runId: string) => {
        updateRun(runId, { slotId: 'proof-slot' });
        const current = await core.readSlotRow('proof-slot');
        await core.updateSlotStatus('proof-slot', {
          current_run_id: runId,
          slot_epoch: Number(current?.slot_epoch ?? 0) + 1,
          branch,
          head_sha: head,
          lifecycle: 'held',
          phase: 'occupied',
          agent: 'idle',
        });
      };
      await bind(run.id);
      const initialKeep = await call<SlotReleaseResult>('slot.release', {
        slotId: 'proof-slot',
        expectedRunId: run.id,
        keepWork: true,
      });
      assert.equal(initialKeep.released, true, initialKeep.reason);
      assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), branch);
      assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
      await bind(run.id);
      const archived = await call<{ ok: boolean }>('run.archive', { runId: run.id });
      assert.equal(archived.ok, true);
      assert.equal(
        git(repo, 'rev-parse', `refs/heads/${branch}`),
        head,
        'run cleanup preserves the original unpushed branch',
      );
      const parked = (await getRunWithArchived(run.id))?.parkedCommits?.at(-1);
      assert.ok(parked);
      assert.equal(parked.headSha, head);
      assert.equal(git(repo, 'rev-parse', parked.ref), head);

      // The named ref remains check-outable without relying on the archived run record.
      git(repo, 'checkout', '-q', branch);
      const follow = createRun({
        flowType: 'dev',
        project: 'proof',
        ticketOrPr: branch,
        slotId: 'proof-slot',
      });
      updateRun(follow.id, {
        status: 'failed',
        branch,
        worktreeHeadAtDispatch: base,
        completedAt: new Date().toISOString(),
      });
      await bind(follow.id);
      const kept = await call<SlotReleaseResult>('slot.release', {
        slotId: 'proof-slot',
        expectedRunId: follow.id,
        keepWork: true,
      });
      assert.equal(kept.released, true, kept.reason);
      assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), branch);
      assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
      runBranches.push({
        status,
        inheritedBaseline,
        branch,
        head,
        parkedRef: parked.ref,
        keepWork: true,
      });
    }
    await writeFile(
      path.join(output, 'ownerless-parking.json'),
      JSON.stringify(parkingCases, null, 2) + '\n',
    );
    assert.equal((await core.readSlotRow('proof-slot'))?.lifecycle, 'ready');
    await writeFile(
      path.join(output, 'rpc.json'),
      JSON.stringify(
        {
          pass: true,
          bulk: update,
          cases: parkingCases,
          runBranches,
          head: git(repo, 'rev-parse', 'HEAD'),
        },
        null,
        2,
      ) + '\n',
    );
  },
);
