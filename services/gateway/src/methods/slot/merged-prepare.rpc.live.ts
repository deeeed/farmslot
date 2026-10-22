// Opt-in prepare proof with disposable Git repositories and an isolated gateway. No worker starts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Methods, type SlotPrepareResult } from '@farmslot/protocol';

import {
  createNativeProofFixture,
  type NativeProofFixture,
} from '../../runtime/native-proof-fixture.live-support.js';

test(
  'prepare accepts a pruned squash merge and preserves genuinely unpublished work over RPC',
  {
    timeout: 120_000,
  },
  async (t) => {
    assert.equal(
      process.env.FARMSLOT_MERGED_PREPARE_LIVE,
      '1',
      'opt in to the private prepare proof',
    );
    const out = process.env.FARMSLOT_MERGED_PREPARE_PROOF_OUT;
    assert.ok(out, 'retain the receipt outside the disposable fixture');
    await mkdir(out, { recursive: true });
    const root = await mkdtemp('/tmp/merged-prepare-');
    let fixture: NativeProofFixture | undefined;
    t.after(async () => {
      if (!fixture) await rm(root, { recursive: true, force: true });
    });
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = path.join(root, 'tmux');
    const project = 'merged-prepare-proof';
    const safe = path.join(root, 'safe');
    const unsafe = path.join(root, 'unsafe');
    const tracked = path.join(root, 'tracked');
    const untracked = path.join(root, 'untracked');
    const published = path.join(root, 'published');
    const origin = path.join(root, 'origin.git');
    for (const dir of [
      'pool',
      'scripts',
      'services/gateway',
      `projects/${project}`,
      'bin',
      'tmux',
      'safe',
    ])
      await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable prepare proof\n');
    await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\nexit 1\n');
    await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
    process.env.FARMSLOT_PREPARE_PROOF_TMUX_LOG = path.join(root, 'tmux-calls');
    await writeFile(
      path.join(root, 'bin/tmux'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FARMSLOT_PREPARE_PROOF_TMUX_LOG"\nexit 1\n',
      { mode: 0o755 },
    );
    process.env.PATH = path.join(root, 'bin') + path.delimiter + process.env.PATH;
    await writeFile(
      path.join(root, 'projects', project, 'project.json'),
      JSON.stringify({
        name: project,
        default_branch: 'main',
        repo_url: origin,
        hooks: {},
        prepare: { profiles: { core: { phases: ['git'] } } },
      }),
    );
    const git = (repo: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const configure = (repo: string) => {
      git(repo, 'config', 'user.name', 'Fixture');
      git(repo, 'config', 'user.email', 'fixture@example.invalid');
      git(repo, 'config', 'commit.gpgsign', 'false');
    };
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(safe, 'init', '-q', '-b', 'main');
    configure(safe);
    await writeFile(path.join(safe, 'base.txt'), 'base\n');
    git(safe, 'add', '.');
    git(safe, 'commit', '-qm', 'base');
    git(safe, 'remote', 'add', 'origin', origin);
    git(safe, 'push', '-q', 'origin', 'main');
    const branch = 'previous-work';
    git(safe, 'checkout', '-qb', branch);
    await writeFile(path.join(safe, 'fix.txt'), 'published fix\n');
    git(safe, 'add', '.');
    git(safe, 'commit', '-qm', 'published fix');
    const publishedHead = git(safe, 'rev-parse', 'HEAD');
    git(safe, 'push', '-q', '-u', 'origin', branch);
    git(safe, 'checkout', '-q', 'main');
    git(safe, 'merge', '--squash', branch);
    git(safe, 'commit', '-qm', 'squash merged fix');
    const mainHead = git(safe, 'rev-parse', 'HEAD');
    git(safe, 'push', '-q', 'origin', 'main');
    git(origin, 'update-ref', '-d', `refs/heads/${branch}`);
    git(safe, 'fetch', '-q', '--prune', 'origin');
    git(safe, 'checkout', '-q', branch);
    assert.match(git(safe, 'cherry', 'origin/main', 'HEAD'), /^- /);
    git(root, 'clone', '-q', safe, unsafe);
    configure(unsafe);
    git(unsafe, 'remote', 'set-url', 'origin', origin);
    git(unsafe, 'fetch', '-q', '--prune', 'origin');
    await writeFile(path.join(unsafe, 'unpublished.txt'), 'keep this work\n');
    git(unsafe, 'add', '.');
    git(unsafe, 'commit', '-qm', 'unpublished work');
    const unpublishedHead = git(unsafe, 'rev-parse', 'HEAD');
    for (const repo of [tracked, untracked, published]) {
      git(root, 'clone', '-q', safe, repo);
      configure(repo);
      git(repo, 'remote', 'set-url', 'origin', origin);
      git(repo, 'fetch', '-q', '--prune', 'origin');
    }
    await writeFile(path.join(tracked, 'fix.txt'), 'operator edit\n');
    await writeFile(path.join(untracked, 'personal-notes.txt'), 'operator notes\n');
    git(published, 'checkout', '-q', 'main');
    await writeFile(path.join(published, 'base.txt'), 'leftover setup output\n');
    const slots = [
      { id: 'merged-prepare-safe', repo: safe },
      { id: 'merged-prepare-unsafe', repo: unsafe },
      { id: 'merged-prepare-tracked', repo: tracked },
      { id: 'merged-prepare-untracked', repo: untracked },
      { id: 'merged-prepare-published', repo: published },
    ];
    await writeFile(
      path.join(root, 'pool/fixture.json'),
      JSON.stringify({
        machine: hostname(),
        host: 'localhost',
        ssh_user: userInfo().username,
        os: process.platform,
        platform: 'cli',
        project,
        slots: slots.map((slot) => ({
          ...slot,
          enabled: true,
          mode: 'dispatch',
          session: slot.id,
        })),
      }),
    );
    await writeFile(
      path.join(root, '.farm-status.json'),
      JSON.stringify({
        checked_at: new Date().toISOString(),
        slots: slots.map((slot) => ({
          slot: slot.id,
          machine: hostname(),
          project,
          platform: 'cli',
          lifecycle: 'ready',
          slot_epoch: 1,
          current_run_id: null,
        })),
      }),
    );
    fixture = await createNativeProofFixture(t, root);
    const { createRun } = await import('../../runs/store.js');
    const ownerPrincipalId = fixture.person.id;
    const makeRun = (slotId: string) => {
      const run = createRun(
        {
          project,
          flowType: 'dev',
          ticketOrPr: 'FIXTURE-1',
          slotId,
          runner: 'claude',
          model: 'haiku',
          transport: 'native',
          branch: 'next-run',
        },
        { nativeOwnerPrincipalId: ownerPrincipalId },
      );
      return run;
    };
    const rejected = makeRun(slots[1].id);
    await assert.rejects(
      fixture.client.call(Methods.SLOT_PREPARE, {
        slotId: slots[1].id,
        runId: rejected.id,
        branch: 'next-run',
        prepareProfile: 'core',
      }),
      /has unpushed commits/,
    );
    assert.equal(git(unsafe, 'rev-parse', 'HEAD'), unpublishedHead);
    assert.equal(git(unsafe, 'rev-parse', branch), unpublishedHead);
    for (const slot of slots.slice(2, 4)) {
      const run = makeRun(slot.id);
      await assert.rejects(
        fixture.client.call(Methods.SLOT_PREPARE, {
          slotId: slot.id,
          runId: run.id,
          branch: 'next-run',
          prepareProfile: 'core',
        }),
        /dirty files/,
      );
      assert.equal(git(slot.repo, 'rev-parse', 'HEAD'), publishedHead);
      assert.equal(git(slot.repo, 'rev-parse', branch), publishedHead);
    }
    assert.equal(await readFile(path.join(tracked, 'fix.txt'), 'utf8'), 'operator edit\n');
    assert.equal(
      await readFile(path.join(untracked, 'personal-notes.txt'), 'utf8'),
      'operator notes\n',
    );
    const accepted = makeRun(slots[0].id);
    const result = await fixture.client.call<SlotPrepareResult>(Methods.SLOT_PREPARE, {
      slotId: slots[0].id,
      runId: accepted.id,
      branch: 'next-run',
      prepareProfile: 'core',
    });
    assert.equal(result.prepared, true);
    assert.equal(git(safe, 'rev-parse', 'HEAD'), mainHead);
    assert.equal(git(safe, 'branch', '--show-current'), 'next-run');
    assert.equal(git(safe, 'rev-parse', branch), publishedHead);
    const publishedRun = makeRun(slots[4].id);
    const publishedResult = await fixture.client.call<SlotPrepareResult>(Methods.SLOT_PREPARE, {
      slotId: slots[4].id,
      runId: publishedRun.id,
      branch: 'next-run',
      prepareProfile: 'core',
    });
    assert.equal(publishedResult.prepared, true);
    assert.equal(git(published, 'rev-parse', 'HEAD'), mainHead);
    assert.equal(await readFile(path.join(published, 'base.txt'), 'utf8'), 'base\n');
    const tmuxCalls = await readFile(path.join(root, 'tmux-calls'), 'utf8').catch(
      (error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
        throw error;
      },
    );
    assert.doesNotMatch(tmuxCalls, /new-session|kill-server/);
    await writeFile(
      path.join(out, 'receipt.json'),
      JSON.stringify(
        {
          method: Methods.SLOT_PREPARE,
          mergedPatchAccepted: true,
          preparedHead: mainHead,
          previousBranchPreserved: publishedHead,
          unpublishedRefusedAndPreserved: unpublishedHead,
          trackedEditRefusedAndPreserved: true,
          untrackedFileRefusedAndPreserved: true,
          existingPublishedCheckoutCleanupPreserved: true,
          workerOrReviewerStarted: false,
          realTmuxServerStarted: false,
        },
        null,
        2,
      ) + '\n',
    );
  },
);
