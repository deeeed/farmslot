// Opt-in authenticated RPC proof with real Git/fixtures and disposable slots.
// No product checkout, model turn or tmux server. PTY is the only substituted transport.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { FleetStatusResult, SlotRefreshResult } from '@farmslot/protocol';

import { createNativeProofFixture } from '../../runtime/native-proof-fixture.live-support.js';

const uiProof = process.env.FARMSLOT_WORKSPACE_UI_PROOF === '1';
const source = fileURLToPath(new URL('../../../../../', import.meta.url));

test(
  'fenced recovery verifies default and fixtures; changed dirt cannot reuse confirmation',
  { timeout: uiProof ? 8 * 60 * 60_000 : 20 * 60_000 },
  async (t) => {
    const output = process.env.FARMSLOT_WORKSPACE_PROOF_OUT;
    assert.ok(output, 'set FARMSLOT_WORKSPACE_PROOF_OUT');
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-recovery-'));
    let fixtureOwnsRoot = false;
    t.after(() => (fixtureOwnsRoot ? undefined : rm(root, { recursive: true, force: true })));
    for (const key of Object.keys(process.env))
      if (/^(FARMSLOT_|GIT_CONFIG|TMUX)/.test(key)) delete process.env[key];
    Object.assign(process.env, {
      NODE_TEST_CONTEXT: '1',
      FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
      FARMSLOT_HOME: path.join(root, 'home'),
      FARMSLOT_ROOT: root,
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    });
    for (const directory of ['home', 'pool', 'projects/proof/fixtures', 'bin', 'seed'])
      await mkdir(path.join(root, directory), { recursive: true });
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
    git(seed, 'config', 'user.name', 'Fixture');
    git(seed, 'config', 'user.email', 'fixture@example.invalid');
    git(seed, 'config', 'commit.gpgsign', 'false');
    git(seed, 'config', 'core.hooksPath', '/dev/null');
    await writeFile(path.join(seed, '.gitignore'), 'fixture.txt\n');
    await writeFile(path.join(seed, 'file.txt'), 'base\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'test: baseline');
    execFileSync('git', ['clone', '--bare', '-q', seed, remote]);
    execFileSync('git', ['clone', '-q', remote, repo]);
    git(repo, 'config', 'user.name', 'Fixture');
    git(repo, 'config', 'user.email', 'fixture@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'config', 'core.hooksPath', '/dev/null');
    git(repo, 'checkout', '-qb', 'previous');
    await writeFile(path.join(repo, 'published.txt'), 'published work\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'test: published slot work');
    git(repo, 'push', '-q', '-u', 'origin', 'previous');
    await writeFile(path.join(root, 'projects/proof/fixtures/fixture.txt'), 'synced fixture\n');
    await writeFile(
      path.join(root, 'projects/proof/project.json'),
      JSON.stringify({
        name: 'proof',
        default_branch: 'main',
        hooks: {},
        scripted: { commands: { proof: { command: 'true', timeout_ms: 5000 } } },
        fixtures: { templates: [{ src: 'fixture.txt', dst: 'fixture.txt' }] },
      }),
    );
    const linkedRepo = path.join(root, 'linked-checkout');
    const emptyRepo = path.join(root, 'no-fixtures-checkout');
    if (!uiProof) {
      git(repo, 'worktree', 'add', '-qb', 'previous-linked', linkedRepo, 'origin/main');
      execFileSync('git', ['clone', '-q', remote, emptyRepo]);
      await mkdir(path.join(root, 'projects/proof-empty'), { recursive: true });
      await writeFile(
        path.join(root, 'projects/proof-empty/project.json'),
        JSON.stringify({ name: 'proof-empty', default_branch: 'main', hooks: {} }),
      );
    }
    await writeFile(
      path.join(root, 'pool/local.json'),
      JSON.stringify({
        machine: os.hostname(),
        host: 'localhost',
        ssh_user: os.userInfo().username,
        project: 'proof',
        platform: 'cli',
        slots: [
          { id: 'proof-slot', repo, session: 'workspace-proof' },
          ...(!uiProof
            ? [
                { id: 'proof-linked', repo: linkedRepo, session: 'workspace-proof-linked' },
                {
                  id: 'proof-empty',
                  repo: emptyRepo,
                  session: 'workspace-proof-empty',
                  project: 'proof-empty',
                },
              ]
            : []),
        ],
      }),
    );
    const initial = {
      slot: 'proof-slot',
      machine: os.hostname(),
      platform: 'cli',
      project: 'proof',
      ssh: 'LOCAL',
      dev: '-',
      devserver: '-',
      cdp: '-',
      fixtures: '0/1',
      branch: 'previous',
      head_sha: git(repo, 'rev-parse', 'HEAD'),
      agent: 'idle',
      enabled: true,
      dispatchable: true,
      lifecycle: 'ready',
      phase: null,
      slot_epoch: 4,
      current_run_id: null,
    };
    await writeFile(
      path.join(root, 'status.json'),
      JSON.stringify({
        checked_at: new Date().toISOString(),
        slots: [
          initial,
          ...(!uiProof
            ? [
                { ...initial, slot: 'proof-linked', branch: 'previous-linked' },
                { ...initial, slot: 'proof-empty', project: 'proof-empty', branch: 'main' },
              ]
            : []),
        ],
      }),
    );
    await import('../../runtime/mock-pty.test-support.js');
    const execution = await import('../../core/exec.js');
    const executeOnSlot: typeof execution.execOnSlot = async (...args) =>
      /\btmux\b/.test(args[1])
        ? { exitCode: 1, stdout: '', stderr: '' }
        : execution.execOnSlot(...args);
    mock.module('../../core/exec.js', {
      namedExports: { ...execution, execOnSlot: executeOnSlot },
    });
    const core = await import('../../core/index.js');
    mock.module('../../core/index.js', { namedExports: { ...core, execOnSlot: executeOnSlot } });
    const tmux = await import('../../core/tmux.js');
    mock.module('../../core/tmux.js', {
      namedExports: { ...tmux, resolveTmuxSession: async () => 'workspace-proof' },
    });

    const fixture = await createNativeProofFixture(t, root);
    fixtureOwnsRoot = true;
    const { initServerGlobals, resetServerGlobalsForTests } = await import('../../server.js');
    initServerGlobals();
    t.after(resetServerGlobalsForTests);
    const connection = await fixture.client.connect();
    t.after(() => connection.close());
    connection.onEvent((event) => {
      if (event.event === 'slot.refresh.step')
        console.log('RECOVERY_STEP', JSON.stringify(event.payload));
    });
    const call = <T>(method: string, params?: unknown) =>
      connection.call<T>(method, params, { timeoutMs: 300_000 });
    if (uiProof) {
      process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '0';
      const secondRepo = path.join(root, 'checkout-two');
      execFileSync('git', ['clone', '-q', remote, secondRepo]);
      git(secondRepo, 'checkout', '-qb', 'previous-two');
      const pool = JSON.parse(await readFile(path.join(root, 'pool/local.json'), 'utf8'));
      pool.slots.push({ id: 'proof-slot-two', repo: secondRepo, session: 'workspace-proof-two' });
      const localRepo = path.join(root, 'checkout-local');
      execFileSync('git', ['clone', '-q', remote, localRepo]);
      git(localRepo, 'config', 'user.name', 'Fixture');
      git(localRepo, 'config', 'user.email', 'fixture@example.invalid');
      git(localRepo, 'config', 'commit.gpgsign', 'false');
      git(localRepo, 'config', 'core.hooksPath', '/dev/null');
      git(localRepo, 'checkout', '-qb', 'local-only');
      await writeFile(path.join(localRepo, 'local.txt'), 'unpublished work\n');
      git(localRepo, 'add', '.');
      git(localRepo, 'commit', '-qm', 'test: unpublished slot work');
      await writeFile(path.join(localRepo, 'local.txt'), 'local changes needing confirmation\n');
      git(localRepo, 'add', 'local.txt');
      pool.slots.push({
        id: 'proof-unpublished',
        repo: localRepo,
        session: 'workspace-proof-local',
      });
      await writeFile(path.join(root, 'pool/local.json'), JSON.stringify(pool));
      const status = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8'));
      status.slots.push({
        ...initial,
        slot: 'proof-slot-two',
        repo: secondRepo,
        branch: 'previous-two',
        head_sha: git(secondRepo, 'rev-parse', 'HEAD'),
      });
      status.slots.push({
        ...initial,
        slot: 'proof-unpublished',
        repo: localRepo,
        branch: 'local-only',
        head_sha: git(localRepo, 'rev-parse', 'HEAD'),
      });
      await writeFile(path.join(root, 'status.json'), JSON.stringify(status));
      await writeFile(
        path.join(root, 'home/gateways.json'),
        JSON.stringify({
          active: 'fleet-proof',
          gateways: {
            'fleet-proof': {
              url: fixture.url,
              authMode: 'token',
              secret: fixture.browserCredential,
            },
          },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(output, 'ui-context.json'),
        JSON.stringify({
          root,
          home: path.join(root, 'home'),
          gatewayUrl: fixture.url,
          repo,
          secondRepo,
          localRepo,
          output,
        }),
        { mode: 0o600 },
      );
      console.log('UI_PROOF_READY');
      const end = Date.now() + 7 * 60 * 60_000;
      while (Date.now() < end) {
        try {
          await readFile(path.join(output, 'ui-finished.json'));
          return;
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error('UI proof did not return its cleanup signal');
    }

    const { inspectSlotWorkspace } = await import('./workspace.js');
    const store = await import('../../runs/store.js');
    const activeOwner = store.createRun(
      {
        project: 'proof',
        flowType: 'dev',
        ticketOrPr: 'PROOF-PROTECTED',
        mode: 'validation',
        slotId: 'proof-slot',
      },
      { nativeOwnerPrincipalId: fixture.person.id },
    );
    const staleIdentity = await inspectSlotWorkspace('proof-slot');
    await core.updateSlotStatus('proof-slot', {
      current_run_id: activeOwner.id,
      lifecycle: 'busy',
      slot_epoch: staleIdentity.epoch + 1,
    });
    const successorRefused = await call<SlotRefreshResult>('slot.refresh', {
      slotId: 'proof-slot',
      release: true,
      mode: 'force',
      expectedWorkspace: staleIdentity,
    });
    assert.equal(successorRefused.reason, 'identity-changed');
    const protectedCases: string[] = [];
    for (const fields of [
      { current_run_id: activeOwner.id, lifecycle: 'busy' },
      { current_run_id: null, lifecycle: 'manual' },
      { current_run_id: null, lifecycle: 'ready', handoff_run_id: activeOwner.id },
      {
        current_run_id: null,
        lifecycle: 'ready',
        handoff_run_id: null,
        cleanup_run_id: activeOwner.id,
      },
    ]) {
      await core.updateSlotStatus('proof-slot', fields);
      const protectedWork = await inspectSlotWorkspace('proof-slot');
      const refused = await call<SlotRefreshResult>('slot.refresh', {
        slotId: 'proof-slot',
        release: true,
        mode: 'force',
        expectedWorkspace: protectedWork,
      });
      assert.equal(refused.refreshed, false);
      assert.equal(refused.reason, 'protected', JSON.stringify({ fields, refused }));
      assert.equal(git(repo, 'branch', '--show-current'), 'previous');
      protectedCases.push(refused.detail ?? 'protected');
    }
    store.updateRun(activeOwner.id, { status: 'done', completedAt: new Date().toISOString() });
    await core.updateSlotStatus('proof-slot', {
      current_run_id: null,
      cleanup_run_id: null,
      handoff_run_id: null,
      lifecycle: 'ready',
      phase: null,
    });
    git(repo, 'remote', 'set-url', 'origin', path.join(root, 'unavailable.git'));
    const unknownWork = await inspectSlotWorkspace('proof-slot');
    assert.equal(unknownWork.publication, 'unknown');
    const unknownRefused = await call<SlotRefreshResult>('slot.refresh', {
      slotId: 'proof-slot',
      release: true,
      mode: 'force',
      expectedWorkspace: unknownWork,
    });
    assert.equal(unknownRefused.reason, 'unknown');
    assert.equal(git(repo, 'branch', '--show-current'), 'previous');
    git(repo, 'remote', 'set-url', 'origin', remote);
    const before = await call<FleetStatusResult>('fleet.status');
    const work = before.fleet.slots.find((slot) => slot.slot === 'proof-slot')?.workspace;
    assert.ok(work);
    const recovered = await call<SlotRefreshResult>('slot.refresh', {
      slotId: 'proof-slot',
      release: true,
      mode: 'safe',
      expectedWorkspace: work,
    });
    assert.equal(recovered.refreshed, true, recovered.detail);
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/main'));
    assert.equal(await readFile(path.join(repo, 'fixture.txt'), 'utf8'), 'synced fixture\n');
    const row = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8')).slots[0];
    assert.equal(row.lifecycle, 'ready');
    assert.equal(row.current_run_id, null);
    assert.equal(row.workspace_recovery, null);
    assert.equal(row.fixtures, 'OK');
    await writeFile(path.join(repo, 'file.txt'), 'first local change\n');
    const dirty = await inspectSlotWorkspace('proof-slot');
    await writeFile(path.join(repo, 'file.txt'), 'changed after confirmation\n');
    const refused = await call<SlotRefreshResult>('slot.refresh', {
      slotId: 'proof-slot',
      release: true,
      mode: 'force',
      expectedWorkspace: dirty,
    });
    assert.equal(refused.refreshed, false);
    assert.equal(refused.reason, 'identity-changed');
    assert.equal(
      await readFile(path.join(repo, 'file.txt'), 'utf8'),
      'changed after confirmation\n',
    );
    git(repo, 'add', 'file.txt');
    await writeFile(path.join(repo, 'untracked.txt'), 'confirmed untracked work');
    const freshDirty = await inspectSlotWorkspace('proof-slot');
    const confirmed = await call<SlotRefreshResult>('slot.refresh', {
      slotId: 'proof-slot',
      release: true,
      mode: 'force',
      expectedWorkspace: freshDirty,
    });
    assert.equal(confirmed.refreshed, true, confirmed.detail);
    const template = path.join(root, 'projects/proof/fixtures/fixture.txt');
    await rename(template, template + '.held');
    const beforeFailure = await inspectSlotWorkspace('proof-slot');
    const failed = await call<SlotRefreshResult>('slot.refresh', {
      slotId: 'proof-slot',
      release: true,
      mode: 'safe',
      expectedWorkspace: beforeFailure,
    });
    assert.equal(failed.refreshed, false);
    const held = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8')).slots[0];
    assert.equal(held.lifecycle, 'held');
    assert.equal(held.phase, 'occupied');
    assert.equal(held.workspace_recovery.phase, 'fixtures');
    await core.updateSlotStatus('proof-slot', {
      lifecycle: 'busy',
      phase: 'releasing',
      releasing_since: '2020-01-01T00:00:00Z',
    });
    const restart = await promisify(execFile)(
      process.execPath,
      [
        '--experimental-test-module-mocks',
        '--import',
        'tsx',
        fileURLToPath(new URL('./workspace-restart.live-support.ts', import.meta.url)),
      ],
      { cwd: source, env: process.env, timeout: 120_000 },
    );
    assert.match(restart.stdout, /FRESH_PROCESS_RECOVERY_HELD/);
    const restartedRow = await core.readSlotRow('proof-slot');
    assert.equal(restartedRow?.lifecycle, 'held');
    assert.equal(restartedRow?.phase, 'occupied');
    assert.deepEqual(restartedRow?.workspace_recovery, held.workspace_recovery);
    const reset = await core.resetSlotIf('proof-slot', () => true);
    assert.equal(reset, false);
    const claim = await core.claimSlotStatusIf('proof-slot', () => true, { lifecycle: 'busy' });
    assert.equal(claim.claimed, false);
    await rename(template + '.held', template);
    const retryWork = await inspectSlotWorkspace('proof-slot');
    const retried = await call<SlotRefreshResult>('slot.refresh', {
      slotId: 'proof-slot',
      release: true,
      mode: 'safe',
      expectedWorkspace: retryWork,
    });
    assert.equal(retried.refreshed, true, retried.detail);
    const exclude = git(repo, 'rev-parse', '--git-path', 'info/exclude');
    await writeFile(path.isAbsolute(exclude) ? exclude : path.join(repo, exclude), '');
    const retained = path.join(repo, '.task/retained/artifacts/report.md');
    await mkdir(path.dirname(retained), { recursive: true });
    await writeFile(retained, 'Retained evidence\n');
    const baseline = await inspectSlotWorkspace('proof-slot');
    assert.equal(baseline.dirtyCount, 0);
    const baselineRefresh = await call<SlotRefreshResult>('slot.refresh', {
      slotId: 'proof-slot',
      release: true,
      mode: 'safe',
      expectedWorkspace: baseline,
    });
    assert.equal(baselineRefresh.refreshed, true, baselineRefresh.detail);
    assert.equal(await readFile(retained, 'utf8'), 'Retained evidence\n');
    const owner = store.createRun(
      {
        project: 'proof',
        flowType: 'dev',
        ticketOrPr: 'PROOF-OWNED',
        mode: 'validation',
        slotId: 'proof-slot',
        runner: 'scripted',
        scripted: { mode: 'command', commandRef: 'proof' },
      },
      { nativeOwnerPrincipalId: fixture.person.id },
    );
    store.updateRun(owner.id, { status: 'done', completedAt: new Date().toISOString() });
    await core.updateSlotStatus('proof-slot', {
      current_run_id: owner.id,
      lifecycle: 'held',
      phase: 'pr-watch',
      agent: 'idle',
    });
    const ownedWorkspace = await inspectSlotWorkspace('proof-slot');
    assert.equal(ownedWorkspace.terminalOwner, true);
    const ownedRelease = await call<SlotRefreshResult>('slot.refresh', {
      slotId: 'proof-slot',
      release: true,
      mode: 'safe',
      expectedWorkspace: ownedWorkspace,
    });
    assert.equal(ownedRelease.refreshed, true, ownedRelease.detail);
    assert.equal((await core.readSlotRow('proof-slot'))?.current_run_id, null);
    const linkedWork = await inspectSlotWorkspace('proof-linked');
    const linkedRelease = await call<SlotRefreshResult>('slot.refresh', {
      slotId: 'proof-linked',
      release: true,
      mode: 'safe',
      expectedWorkspace: linkedWork,
    });
    assert.equal(linkedRelease.refreshed, true, linkedRelease.detail);
    assert.equal(git(linkedRepo, 'branch', '--show-current'), 'wt/workspace-proof-linked');
    assert.equal(git(linkedRepo, 'rev-parse', 'HEAD'), git(linkedRepo, 'rev-parse', 'origin/main'));
    assert.equal(await readFile(path.join(linkedRepo, 'fixture.txt'), 'utf8'), 'synced fixture\n');
    for (const [key, value] of [
      ['user.name', 'Fixture'],
      ['user.email', 'fixture@example.invalid'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '/dev/null'],
    ])
      git(emptyRepo, 'config', key, value);
    git(emptyRepo, 'checkout', '-qb', 'squashed-deleted');
    await writeFile(path.join(emptyRepo, 'squash.txt'), 'squashed work\n');
    git(emptyRepo, 'add', 'squash.txt');
    git(emptyRepo, 'commit', '-qm', 'test: branch work');
    git(emptyRepo, 'push', '-qu', 'origin', 'squashed-deleted');
    await writeFile(path.join(seed, 'squash.txt'), 'squashed work\n');
    git(seed, 'add', 'squash.txt');
    git(seed, 'commit', '-qm', 'test: squash merged work');
    git(seed, 'push', '-q', remote, 'main');
    git(emptyRepo, 'push', '-q', 'origin', '--delete', 'squashed-deleted');
    git(emptyRepo, 'fetch', '-q', 'origin', 'main');
    const emptyWork = await inspectSlotWorkspace('proof-empty');
    assert.equal(emptyWork.publication, 'merged', 'Deleted squash branch is covered by its patch');
    const emptyRelease = await call<SlotRefreshResult>('slot.refresh', {
      slotId: 'proof-empty',
      release: true,
      mode: 'safe',
      expectedWorkspace: emptyWork,
    });
    assert.equal(emptyRelease.refreshed, true, emptyRelease.detail);
    assert.equal((await core.readSlotRow('proof-empty'))?.fixtures, 'not-required');
    const result = {
      pass: true,
      recovered,
      refused,
      confirmed,
      failed,
      restart: { held: true, freshProcess: true },
      retried,
      baselineRefresh,
      ownedRelease,
      successorRefused,
      protectedCases,
      unknownRefused,
      linkedRelease,
      emptyRelease,
      deletedSquashMerged: emptyWork.publication === 'merged',
      branch: git(repo, 'branch', '--show-current'),
      head: git(repo, 'rev-parse', 'HEAD'),
      row,
      proof:
        'authenticated RPC + real Git and fixture sync; UI/automatic dispatch proof remains separate',
    };
    await writeFile(path.join(output, 'rpc.json'), JSON.stringify(result, null, 2) + '\n');
  },
);
