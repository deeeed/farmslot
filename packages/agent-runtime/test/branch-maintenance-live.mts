import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  executeBranchMaintenance,
  inspectBranchMaintenance,
  pushBranchMaintenance,
  verifyBranchMaintenance,
  executeOrdinaryBranchMaintenance,
  pushOrdinaryBranchMaintenance,
} from '../src/task-init/branch-update.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'branch-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
  };
  const raw = (args: string[], cwd = root) =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  raw(['init', '--bare', remote]);
  raw(['clone', remote, repo]);
  const git = (...args: string[]) => raw(args, repo);
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const commit = (name: string, value: string) => {
    writeFileSync(path.join(repo, name), value);
    git('add', '--', name);
    git('commit', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  git('checkout', '-b', 'main');
  commit('base', 'base');
  git('push', 'origin', 'main');
  git('checkout', '-b', 'parent');
  const first = commit('parent-one', 'one');
  const boundary = commit('parent-two', 'two');
  git('push', 'origin', 'parent');
  git('checkout', '-b', 'child');
  const source = commit('child-only', 'child');
  git('push', 'origin', 'child');
  const inspect = (comparison = boundary, replay = boundary, head = source) =>
    inspectBranchMaintenance({
      id: 'test',
      ownerRunId: 'owner',
      project: 'fixture',
      repo,
      branch: 'child',
      baseRef: 'parent',
      kind: 'rebase',
      authority: { comparisonBaseSha: comparison, replayBoundarySha: replay, headSha: head },
    });
  return { root, repo, remote, raw, git, commit, first, boundary, source, inspect };
}

test('prepare provenance prevents a live merge-base from replaying a removed parent', (t) => {
  const f = fixture(t);
  f.git('push', 'origin', `${f.first}:refs/heads/parent`, '--force');
  const operation = f.inspect(f.first);
  assert.equal(operation.comparisonBaseSha, f.boundary);
  executeBranchMaintenance(operation);
  pushBranchMaintenance(operation);
  assert.equal(verifyBranchMaintenance(operation).headSha, f.git('rev-parse', 'HEAD'));
  assert.equal(f.git('rev-list', '--count', `${f.first}..HEAD`), '1');
  assert.throws(() => readFileSync(path.join(f.repo, 'parent-two')));
  assert.equal(readFileSync(path.join(f.repo, 'child-only'), 'utf8'), 'child');
});

test('remote-only child changes refuse before rebase', (t) => {
  const f = fixture(t);
  const operation = f.inspect();
  const source = f.source;
  f.commit('remote-edit', 'edit');
  f.git('push', 'origin', 'child');
  f.git('reset', '--hard', source);
  assert.throws(() => executeBranchMaintenance(operation), /REMOTE_CHILD_CHANGED/);
  assert.equal(f.git('rev-parse', 'HEAD'), source);
});

test('a result from another operation cannot use the recorded push lease', (t) => {
  const f = fixture(t);
  const operation = f.inspect();
  executeBranchMaintenance(operation);
  assert.throws(
    () => pushBranchMaintenance({ ...operation, targetSha: f.first }),
    /OPERATION_CHANGED/,
  );
});

function receiptFile(repo: string, id = 'test'): string {
  return path.join(
    repo,
    '.git',
    `farmslot-branch-${createHash('sha256').update(id).digest('hex')}.json`,
  );
}

function checkpoint(operation: ReturnType<typeof inspectBranchMaintenance>, headSha: string) {
  return {
    project: operation.project,
    repo: operation.repo,
    branch: operation.branch,
    baseRef: operation.baseRef,
    baseSha: operation.targetSha,
    headSha,
    replayBoundarySha: operation.targetSha,
    capturedAt: new Date().toISOString(),
    source: 'local-git' as const,
  };
}

test('handoff pins the remote child while the slot still occupies another branch', (t) => {
  const f = fixture(t);
  f.git('checkout', 'main');
  const operation = f.inspect();
  assert.equal(operation.sourceHeadSha, f.source);
  assert.throws(() => executeBranchMaintenance(operation), /BRANCH_CHANGED/);
  f.git('checkout', 'child');
  executeBranchMaintenance(operation);
  pushBranchMaintenance(operation);
});

test('parent rebase and two subsequent child rebases renew a child-only boundary', (t) => {
  const f = fixture(t);
  f.git('checkout', 'main');
  const main = f.commit('main-new', 'new default');
  f.git('push', 'origin', 'main');
  f.git('checkout', 'parent');
  f.git('rebase', 'main');
  f.git('push', 'origin', 'parent', '--force');
  const target = f.git('rev-parse', 'HEAD');
  f.git('checkout', 'child');
  const first = f.inspect();
  executeBranchMaintenance(first);
  pushBranchMaintenance(first);
  const firstHead = verifyBranchMaintenance(first).headSha;
  assert.equal(f.git('rev-list', '--count', `${target}..HEAD`), '1');
  assert.equal(f.git('merge-base', main, 'HEAD'), main);
  f.git('checkout', 'parent');
  const nextTarget = f.commit('parent-next', 'next');
  f.git('push', 'origin', 'parent');
  f.git('checkout', 'child');
  const second = inspectBranchMaintenance({
    id: 'second',
    ownerRunId: 'owner',
    project: 'fixture',
    repo: f.repo,
    branch: 'child',
    baseRef: 'parent',
    kind: 'rebase',
    authority: { headSha: firstHead, comparisonBaseSha: target, replayBoundarySha: target },
    expectedCheckpoint: checkpoint(first, firstHead),
  });
  executeBranchMaintenance(second);
  pushBranchMaintenance(second);
  assert.equal(verifyBranchMaintenance(second).replayBoundarySha, nextTarget);
  assert.equal(f.git('rev-list', '--count', `${nextTarget}..HEAD`), '1');
  assert.equal(readFileSync(path.join(f.repo, 'child-only'), 'utf8'), 'child');
});

test('restart before push and after push recovers the durable guarded result idempotently', (t) => {
  const f = fixture(t);
  f.git('checkout', 'parent');
  f.commit('parent-next', 'next');
  f.git('push', 'origin', 'parent');
  f.git('checkout', 'child');
  const operation = f.inspect();
  const head = executeBranchMaintenance(operation);
  const file = receiptFile(f.repo);
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(receipt.observedHeadSha, head);
  // A process can stop after rebase's final exec but before SDK completion.
  receipt.phase = 'rebasing';
  delete receipt.resultHeadSha;
  delete receipt.rebaseResultSha;
  writeFileSync(file, JSON.stringify(receipt));
  assert.equal(executeBranchMaintenance(operation), head);
  pushBranchMaintenance(operation);
  assert.equal(executeBranchMaintenance(operation), head);
  pushBranchMaintenance(operation);
  assert.equal(verifyBranchMaintenance(operation).headSha, head);
});

test('continued conflicts retain the original source and refuse unrelated replacement heads', (t) => {
  const f = fixture(t);
  const owned = f.commit('base', 'child');
  f.git('push', 'origin', 'child');
  f.git('checkout', 'parent');
  f.commit('base', 'parent');
  f.git('push', 'origin', 'parent');
  f.git('checkout', 'child');
  const operation = f.inspect(f.boundary, f.boundary, owned);
  assert.throws(() => executeBranchMaintenance(operation), /RESOLVE_REBASE_CONFLICT/);
  assert.throws(() => executeBranchMaintenance(operation), /RESOLVE_REBASE_CONFLICT/);
  writeFileSync(path.join(f.repo, 'base'), 'resolved child');
  f.git('add', 'base');
  f.git('-c', 'core.editor=true', 'rebase', '--continue');
  const head = executeBranchMaintenance(operation);
  assert.equal(readFileSync(path.join(f.repo, 'base'), 'utf8'), 'resolved child');
  pushBranchMaintenance(operation);
  f.git('reset', '--hard', operation.targetSha);
  assert.throws(() => executeBranchMaintenance(operation), /LOCAL_RESULT_CHANGED/);
  assert.equal(verifyBranchMaintenance(operation).headSha, head);
});

test('all phases fence a changed target and an up-to-date head cannot bypass a missing receipt', (t) => {
  const f = fixture(t);
  const operation = f.inspect();
  assert.throws(() => verifyBranchMaintenance(operation), /GUARDED_RESULT_MISSING/);
  f.git('checkout', 'parent');
  f.commit('parent-next', 'next');
  f.git('push', 'origin', 'parent');
  f.git('checkout', 'child');
  for (const phase of [executeBranchMaintenance, pushBranchMaintenance, verifyBranchMaintenance])
    assert.throws(() => phase(operation), /TARGET_CHANGED/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.source);
});

test('worker commits appended after the guard use the same verified exact lease', (t) => {
  const f = fixture(t);
  const operation = f.inspect();
  executeBranchMaintenance(operation);
  const head = f.commit('worker-fix', 'owned fix');
  pushBranchMaintenance(operation);
  assert.equal(verifyBranchMaintenance(operation).headSha, head);
  assert.equal(readFileSync(path.join(f.repo, 'worker-fix'), 'utf8'), 'owned fix');
});

test('a forbidden rewrite refuses without changing the remote or using a merge fallback', (t) => {
  const f = fixture(t);
  f.git('checkout', 'parent');
  f.commit('parent-next', 'next');
  f.git('push', 'origin', 'parent');
  f.git('checkout', 'child');
  const operation = f.inspect();
  executeBranchMaintenance(operation);
  f.raw(['config', 'receive.denyNonFastForwards', 'true'], f.remote);
  assert.throws(() => pushBranchMaintenance(operation), /PUSH_REFUSED/);
  assert.equal(f.raw(['rev-parse', 'refs/heads/child'], f.remote), f.source);
  assert.equal(f.git('rev-list', '--merges', `${operation.targetSha}..HEAD`), '');
});

test('ordinary commands share guarded execution and repeat after a published maintenance', (t) => {
  const f = fixture(t);
  const request = { kind: 'ordinary' as const, repo: f.repo, branch: 'child', baseRef: 'parent' };
  executeOrdinaryBranchMaintenance(request);
  pushOrdinaryBranchMaintenance(request);
  f.git('checkout', 'parent');
  const target = f.commit('parent-next', 'next');
  f.git('push', 'origin', 'parent');
  f.git('checkout', 'child');
  executeOrdinaryBranchMaintenance(request);
  pushOrdinaryBranchMaintenance(request);
  pushOrdinaryBranchMaintenance(request);
  assert.equal(f.git('merge-base', target, 'HEAD'), target);
  assert.equal(f.git('rev-list', '--count', `${target}..HEAD`), '1');
});

test('graph catch-up verifies ordered parents and the exact clean merge tree', (t) => {
  const f = fixture(t);
  f.git('checkout', 'parent');
  f.commit('parent-next', 'next');
  f.git('push', 'origin', 'parent');
  f.git('checkout', 'child');
  const operation = inspectBranchMaintenance({
    id: 'graph',
    ownerRunId: 'owner',
    project: 'fixture',
    repo: f.repo,
    branch: 'child',
    baseRef: 'parent',
    kind: 'graph-merge',
    authority: { headSha: f.source, comparisonBaseSha: f.boundary, replayBoundarySha: f.boundary },
  });
  assert.throws(() => verifyBranchMaintenance(operation), /GRAPH_UPDATE_PENDING/);
  f.git('merge', '--no-ff', operation.targetSha, '-m', 'graph catch-up');
  f.git('push', 'origin', 'child');
  const merge = f.git('rev-parse', 'HEAD');
  assert.equal(verifyBranchMaintenance(operation).headSha, merge);
  const tree = f.git('rev-parse', 'HEAD^{tree}');
  const reversed = f.git(
    'commit-tree',
    tree,
    '-p',
    operation.targetSha,
    '-p',
    f.source,
    '-m',
    'wrong parents',
  );
  f.git('push', 'origin', `${reversed}:refs/heads/child`, '--force');
  assert.throws(() => verifyBranchMaintenance(operation), /GRAPH_MERGE_CHANGED/);
  const wrong = f.commit('foreign', 'foreign');
  const wrongTree = f.git('rev-parse', `${wrong}^{tree}`);
  const changed = f.git(
    'commit-tree',
    wrongTree,
    '-p',
    f.source,
    '-p',
    operation.targetSha,
    '-m',
    'wrong tree',
  );
  f.git('push', 'origin', `${changed}:refs/heads/child`, '--force');
  assert.throws(() => verifyBranchMaintenance(operation), /GRAPH_MERGE_TREE_CHANGED/);
});

test('retarget after squash and graph merge excludes parent content reverted by main', (t) => {
  const f = fixture(t);
  f.git('checkout', 'main');
  f.git('merge', '--squash', 'parent');
  f.git('commit', '-m', 'upstream squash');
  const upstream = f.git('rev-parse', 'HEAD');
  f.git('push', 'origin', 'main');
  f.git('checkout', 'child');
  f.git('merge', '--no-ff', 'main', '-m', 'graph catch-up');
  const graphHead = f.git('rev-parse', 'HEAD');
  f.git('push', 'origin', 'child');
  f.git('checkout', 'main');
  f.git('revert', '--no-edit', upstream);
  f.git('push', 'origin', 'main');
  const target = f.git('rev-parse', 'HEAD');
  f.git('checkout', 'child');
  f.commit('child-next', 'next');
  f.git('push', 'origin', 'child');
  const operation = inspectBranchMaintenance({
    id: 'retarget',
    ownerRunId: 'owner',
    project: 'fixture',
    repo: f.repo,
    branch: 'child',
    baseRef: 'main',
    kind: 'rebase',
    authority: { headSha: graphHead, comparisonBaseSha: upstream, replayBoundarySha: f.boundary },
    upstreamMergeSha: upstream,
    expectedCheckpoint: {
      baseRef: 'main',
      baseSha: upstream,
      headSha: graphHead,
      replayBoundarySha: f.boundary,
      capturedAt: new Date().toISOString(),
      source: 'local-git',
    },
  });
  const result = executeBranchMaintenance(operation);
  pushBranchMaintenance(operation);
  assert.equal(verifyBranchMaintenance(operation).headSha, result);
  assert.equal(f.git('rev-list', '--count', `${target}..HEAD`), '1');
  assert.throws(() => readFileSync(path.join(f.repo, 'parent-one')));
  assert.throws(() => readFileSync(path.join(f.repo, 'parent-two')));
  assert.equal(readFileSync(path.join(f.repo, 'child-only'), 'utf8'), 'child');
  assert.equal(readFileSync(path.join(f.repo, 'child-next'), 'utf8'), 'next');
});

test('merged history retains owned merge resolutions after a main rollback', (t) => {
  const f = fixture(t);
  f.commit('base', 'child edit');
  f.git('push', 'origin', 'child');
  f.git('checkout', 'main');
  f.git('merge', '--squash', 'parent');
  f.git('commit', '-m', 'upstream squash');
  const upstream = f.git('rev-parse', 'HEAD');
  const comparison = f.commit('base', 'default edit');
  f.git('push', 'origin', 'main');
  f.git('checkout', 'child');
  assert.throws(() => f.git('merge', '--no-ff', 'main', '-m', 'graph merge'));
  assert.equal(f.git('diff', '--name-only', '--diff-filter=U'), 'base');
  writeFileSync(path.join(f.repo, 'base'), 'owned merge resolution');
  f.git('add', 'base');
  f.git('commit', '-m', 'resolve graph merge');
  const source = f.git('rev-parse', 'HEAD');
  f.git('push', 'origin', 'child');
  f.git('checkout', 'main');
  f.git('revert', '--no-edit', upstream);
  f.git('push', 'origin', 'main');
  f.git('checkout', 'child');
  f.git('checkout', '-b', 'ordinary', source);
  f.git('push', 'origin', 'ordinary');
  const ordinary = { kind: 'ordinary' as const, repo: f.repo, branch: 'ordinary', baseRef: 'main' };
  executeOrdinaryBranchMaintenance(ordinary);
  pushOrdinaryBranchMaintenance(ordinary);
  assert.equal(readFileSync(path.join(f.repo, 'base'), 'utf8'), 'owned merge resolution');
  assert.throws(() => readFileSync(path.join(f.repo, 'parent-one')));
  f.git('checkout', 'child');
  const operation = inspectBranchMaintenance({
    id: 'merge-resolution',
    ownerRunId: 'owner',
    project: 'fixture',
    repo: f.repo,
    branch: 'child',
    baseRef: 'main',
    kind: 'rebase',
    authority: { headSha: source, comparisonBaseSha: comparison, replayBoundarySha: f.boundary },
    upstreamMergeSha: upstream,
    expectedCheckpoint: {
      baseRef: 'main',
      baseSha: comparison,
      headSha: source,
      replayBoundarySha: f.boundary,
      capturedAt: new Date().toISOString(),
      source: 'local-git',
    },
  });
  executeBranchMaintenance(operation);
  pushBranchMaintenance(operation);
  verifyBranchMaintenance(operation);
  assert.equal(readFileSync(path.join(f.repo, 'base'), 'utf8'), 'owned merge resolution');
  assert.equal(readFileSync(path.join(f.repo, 'child-only'), 'utf8'), 'child');
  assert.throws(() => readFileSync(path.join(f.repo, 'parent-one')));
  assert.throws(() => readFileSync(path.join(f.repo, 'parent-two')));
});

test('the replay source is durable before reset and an unstarted reconstructed replay can resume', (t) => {
  const f = fixture(t);
  f.git('checkout', 'parent');
  const comparison = f.commit('parent-next', 'next');
  f.git('push', 'origin', 'parent');
  f.git('checkout', 'child');
  f.git('merge', '--no-ff', 'parent', '-m', 'known catch-up');
  const source = f.git('rev-parse', 'HEAD');
  f.git('push', 'origin', 'child');
  f.git('push', 'origin', `${f.boundary}:refs/heads/parent`, '--force');
  const operation = inspectBranchMaintenance({
    id: 'before-reset',
    ownerRunId: 'owner',
    project: 'fixture',
    repo: f.repo,
    branch: 'child',
    baseRef: 'parent',
    kind: 'rebase',
    authority: { headSha: source, comparisonBaseSha: comparison, replayBoundarySha: f.boundary },
    expectedCheckpoint: {
      baseRef: 'parent',
      baseSha: comparison,
      headSha: source,
      replayBoundarySha: f.boundary,
      capturedAt: new Date().toISOString(),
      source: 'local-git',
    },
  });
  const file = receiptFile(f.repo, operation.id);
  const hook = path.join(f.repo, '.git/hooks/pre-rebase');
  writeFileSync(hook, '#!/bin/sh\ntest -s ' + "'" + file + "'" + ' || exit 7\nexit 9\n', {
    mode: 0o755,
  });
  assert.throws(() => executeBranchMaintenance(operation));
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(receipt.phase, 'rebasing');
  assert.equal(receipt.sourceHeadSha, source);
  assert.notEqual(receipt.replayHeadSha, source);
  // Model the earlier crash window between durable input and reset.
  f.git('reset', '--hard', source);
  rmSync(hook);
  executeBranchMaintenance(operation);
  pushBranchMaintenance(operation);
  verifyBranchMaintenance(operation);
  assert.equal(readFileSync(path.join(f.repo, 'child-only'), 'utf8'), 'child');
  assert.throws(() => readFileSync(path.join(f.repo, 'parent-next')));
});

test('the public runtime script runs the captured operation and emits typed refusal JSON', (t) => {
  const f = fixture(t);
  const script = fileURLToPath(new URL('../scripts/branch-update.mjs', import.meta.url));
  const call = (phase: string, input: unknown) =>
    spawnSync(process.execPath, [script, phase, JSON.stringify(input)], {
      cwd: f.repo,
      encoding: 'utf8',
    });
  f.git('push', 'origin', `${f.first}:refs/heads/parent`, '--force');
  f.git('checkout', 'main');
  const inspected = call('inspect', {
    id: 'public',
    ownerRunId: 'owner',
    project: 'fixture',
    repo: f.repo,
    branch: 'refs/remotes/origin/child',
    baseRef: 'refs/heads/parent',
    kind: 'rebase',
    authority: { headSha: f.source, comparisonBaseSha: f.first, replayBoundarySha: f.boundary },
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  const operation = JSON.parse(inspected.stdout);
  const refused = call('execute', operation);
  assert.equal(refused.status, 2);
  assert.equal(JSON.parse(refused.stderr).code, 'BRANCH_CHANGED');
  f.git('checkout', 'child');
  const executed = call('execute', operation);
  assert.equal(executed.status, 0, executed.stderr);
  const result = JSON.parse(executed.stdout);
  const pushed = call('push', operation);
  assert.equal(pushed.status, 0, pushed.stderr);
  const verified = call('verify', operation);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).headSha, result);
  assert.equal(f.git('rev-list', '--count', `${f.first}..HEAD`), '1');
  assert.throws(() => readFileSync(path.join(f.repo, 'parent-two')));
});

test('remote-only commits captured at pin time refuse a checkout that omits them', (t) => {
  const f = fixture(t);
  f.commit('remote-only', 'remote');
  f.git('push', 'origin', 'child');
  f.git('reset', '--hard', f.source);
  const operation = f.inspect();
  assert.throws(() => executeBranchMaintenance(operation), /REMOTE_CHILD_COMMITS_MISSING/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.source);
});

test('ordinary admission on the wrong checkout does not poison the subsequent attempt', (t) => {
  const f = fixture(t);
  const request = { kind: 'ordinary' as const, repo: f.repo, branch: 'child', baseRef: 'parent' };
  f.git('checkout', 'main');
  assert.throws(() => executeOrdinaryBranchMaintenance(request), /BRANCH_CHANGED/);
  f.git('checkout', 'child');
  executeOrdinaryBranchMaintenance(request);
  pushOrdinaryBranchMaintenance(request);
});

test('an unverified merge beyond the authoritative child head refuses at inspection', (t) => {
  const f = fixture(t);
  f.git('checkout', '-b', 'foreign', 'main');
  f.commit('foreign', 'unverified');
  f.git('checkout', 'child');
  f.git('merge', '--no-ff', 'foreign', '-m', 'unverified merge');
  f.git('push', 'origin', 'child');
  assert.throws(() => f.inspect(), /UNVERIFIED_MERGE/);
});

test('explicit child and target fetches work with a narrow configured origin refspec', (t) => {
  const f = fixture(t);
  f.git(
    'config',
    '--replace-all',
    'remote.origin.fetch',
    '+refs/heads/child:refs/remotes/origin/child',
  );
  f.git('update-ref', '-d', 'refs/remotes/origin/parent');
  const operation = f.inspect();
  assert.equal(operation.targetSha, f.boundary);
  executeBranchMaintenance(operation);
  pushBranchMaintenance(operation);
  assert.equal(verifyBranchMaintenance(operation).headSha, f.git('rev-parse', 'HEAD'));
});

test('a failed fetch remains a typed refusal and cannot mark branch maintenance current', (t) => {
  const f = fixture(t);
  const operation = f.inspect();
  f.git('config', 'remote.origin.url', path.join(f.root, 'missing.git'));
  assert.throws(() => executeBranchMaintenance(operation), /FETCH_FAILED/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.source);
});

test('a parent advance after the successful lease push renews the pinned result on restart', (t) => {
  const f = fixture(t);
  f.git('checkout', 'parent');
  f.commit('parent-next', 'next');
  f.git('push', 'origin', 'parent');
  f.git('checkout', 'child');
  const operation = f.inspect();
  const result = executeBranchMaintenance(operation);
  assert.throws(() => verifyBranchMaintenance(operation), /REMOTE_RESULT_CHANGED/);
  pushBranchMaintenance(operation);
  const file = receiptFile(f.repo);
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  delete receipt.pushedHeadSha;
  writeFileSync(file, JSON.stringify(receipt));
  f.git('checkout', 'parent');
  f.commit('parent-after-push', 'advance');
  f.git('push', 'origin', 'parent');
  f.git('checkout', 'child');
  assert.throws(() => executeBranchMaintenance(operation), /TARGET_CHANGED/);
  assert.throws(() => pushBranchMaintenance(operation), /TARGET_CHANGED/);
  assert.deepEqual(verifyBranchMaintenance(operation), {
    headSha: result,
    replayBoundarySha: operation.targetSha,
  });
});

test('an unpushed no-op cannot renew after a parent advance', (t) => {
  const f = fixture(t);
  const operation = f.inspect();
  executeBranchMaintenance(operation);
  assert.throws(() => verifyBranchMaintenance(operation), /RESULT_NOT_PUSHED/);
  f.git('checkout', 'parent');
  f.commit('parent-next', 'next');
  f.git('push', 'origin', 'parent');
  f.git('checkout', 'child');
  assert.throws(() => verifyBranchMaintenance(operation), /TARGET_CHANGED/);
});
