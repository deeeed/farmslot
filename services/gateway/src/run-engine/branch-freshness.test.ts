import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ReadyGatePayload } from '@farmslot/protocol';

import {
  applyBranchFreshnessToReadyGatePayload,
  buildBranchFreshnessProbeScript,
  formatBranchFreshnessHint,
  parseBranchFreshnessProbeOutput,
  parseMergeTreeConflictPaths,
  parseRevListCount,
  resolveBranchUpdateStrategy,
  sanitizeDefaultBranch,
} from './branch-freshness.js';

test('parseRevListCount accepts non-negative integers and rejects garbage', () => {
  assert.equal(parseRevListCount('21\n'), 21);
  assert.equal(parseRevListCount('0'), 0);
  assert.equal(parseRevListCount(' 3 '), 3);
  assert.equal(parseRevListCount('not-a-number'), null);
  assert.equal(parseRevListCount(''), null);
});

test('parseMergeTreeConflictPaths reads CONFLICT lines and name-only paths; ignores free-text conflict', () => {
  assert.deepEqual(parseMergeTreeConflictPaths('merged\n  result 100644 abc path/file.ts\n'), []);

  const writeTreeStyle = [
    'b114767202945f02e884bced2bc24ea98c9f7785',
    'apps/command-center/ui/src/gate.ts',
    '',
    'Auto-merging apps/command-center/ui/src/gate.ts',
    'CONFLICT (content): Merge conflict in apps/command-center/ui/src/gate.ts',
    '',
  ].join('\n');
  const paths = parseMergeTreeConflictPaths(writeTreeStyle);
  assert.ok(paths.some((p) => p.includes('gate.ts')));

  // Docs that say "CONFLICT" must not flip path extraction.
  const docsOnly = 'See the CONFLICT section of the guide for details.\n';
  assert.deepEqual(parseMergeTreeConflictPaths(docsOnly), []);

  // modify/delete lines end with "in origin/main" — that is a ref, not a path.
  // Real path comes from name-only lines (x.ts).
  const modifyDelete = [
    'x.ts',
    'CONFLICT (modify/delete): x.ts deleted in HEAD and modified in origin/main',
    '',
  ].join('\n');
  const mdPaths = parseMergeTreeConflictPaths(modifyDelete);
  assert.ok(mdPaths.includes('x.ts'));
  assert.ok(!mdPaths.includes('origin/main'));
});

test('formatBranchFreshnessHint prefers merge during open review loops', () => {
  const upToDate = formatBranchFreshnessHint({
    behindMain: 0,
    mergeConflicts: false,
    defaultBranch: 'main',
    remoteRefOk: true,
  });
  assert.match(upToDate, /behindMain: 0/);
  assert.match(upToDate, /up to date/);

  const behind = formatBranchFreshnessHint({
    behindMain: 21,
    mergeConflicts: false,
    defaultBranch: 'main',
    strategy: 'merge',
    remoteRefOk: true,
  });
  assert.match(behind, /behindMain: 21/);
  assert.match(behind, /git merge origin\/main/);
  assert.doesNotMatch(behind, /force-with-lease/);

  const missingRef = formatBranchFreshnessHint({
    defaultBranch: 'main',
    remoteRefOk: false,
    fetchOk: true,
  });
  assert.match(missingRef, /not available after fetch/);
  assert.doesNotMatch(missingRef, /git merge origin\/main/);

  const fetchFailed = formatBranchFreshnessHint({
    defaultBranch: 'main',
    remoteRefOk: false,
    fetchOk: false,
  });
  assert.match(fetchFailed, /fetch origin main failed/);
  assert.match(fetchFailed, /stale/);
  assert.doesNotMatch(fetchFailed, /up to date/);
});

test('buildBranchFreshnessProbeScript verifies remote ref and is non-destructive', () => {
  const script = buildBranchFreshnessProbeScript('/tmp/slot-repo', 'main');
  assert.match(script, /git -C .* fetch origin main/);
  assert.match(script, /fetch_rc=\$\?/);
  assert.match(script, /FETCH_OK:/);
  assert.match(script, /rev-parse --verify --quiet "origin\/main\^\{commit\}"/);
  assert.match(script, /rev-list --count "HEAD\.\.origin\/main"/);
  assert.match(script, /merge-tree --write-tree --name-only HEAD "origin\/main"/);
  assert.match(script, /BEHIND:unknown/);
  assert.match(script, /AHEAD:unknown/);
  assert.match(script, /CONFLICT_EXIT:unknown/);
  assert.doesNotMatch(script, /\|\| echo 0/);
  assert.doesNotMatch(script, /rebase/);
  assert.doesNotMatch(script, /push/);
  assert.equal(script.includes('--force'), false);
});

test('parseBranchFreshnessProbeOutput fails closed when ref missing, fetch failed, or counts unknown', () => {
  const withConflict = [
    'HEAD:abc1234',
    'FETCH_OK:1',
    'REF_OK:1',
    'BEHIND:21',
    'AHEAD:2',
    'CONFLICT_EXIT:1',
    'TREE_BEGIN',
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    'services/gateway/src/x.ts',
    'CONFLICT (content): Merge conflict in services/gateway/src/x.ts',
    'TREE_END',
    '',
  ].join('\n');
  const summary = parseBranchFreshnessProbeOutput(withConflict, 'main', 'merge');
  assert.equal(summary.behindMain, 21);
  assert.equal(summary.aheadMain, 2);
  assert.equal(summary.mergeConflicts, true);
  assert.ok(summary.mergeConflictPaths.some((p) => p.includes('x.ts')));
  assert.equal(summary.headSha, 'abc1234');
  assert.equal(summary.remoteRefOk, true);
  assert.equal(summary.fetchOk, true);

  // Missing remote ref: do NOT claim conflicts or zero-ahead.
  const missingRef = [
    'HEAD:abc1234',
    'FETCH_OK:1',
    'REF_OK:0',
    'BEHIND:unknown',
    'AHEAD:unknown',
    'CONFLICT_EXIT:unknown',
    'TREE_BEGIN',
    'merge-tree: origin/main - not something we can merge',
    'TREE_END',
    '',
  ].join('\n');
  const unknown = parseBranchFreshnessProbeOutput(missingRef, 'main', 'merge');
  assert.equal(unknown.remoteRefOk, false);
  assert.equal(unknown.fetchOk, true);
  assert.equal(unknown.behindMain, undefined);
  assert.equal(unknown.aheadMain, undefined);
  assert.equal(unknown.mergeConflicts, undefined);
  assert.deepEqual(unknown.mergeConflictPaths, []);
  // Must not look like zero-ahead for close-as-shipped.
  assert.notEqual(unknown.aheadMain, 0);

  // Failed fetch with stale local tracking counts present in stdout — must omit.
  const staleAfterFetchFail = [
    'HEAD:abc1234',
    'FETCH_OK:0',
    'REF_OK:0',
    'BEHIND:0',
    'AHEAD:1',
    'CONFLICT_EXIT:0',
    'TREE_BEGIN',
    'TREE_END',
    '',
  ].join('\n');
  const stale = parseBranchFreshnessProbeOutput(staleAfterFetchFail, 'main', 'merge');
  assert.equal(stale.fetchOk, false);
  assert.equal(stale.remoteRefOk, false);
  assert.equal(stale.behindMain, undefined);
  assert.equal(stale.aheadMain, undefined);
  assert.equal(stale.mergeConflicts, undefined);
  assert.match(stale.hint, /fetch origin main failed/);
  assert.doesNotMatch(stale.hint, /up to date/);

  // Free-text "CONFLICT" with clean exit must NOT report conflicts.
  const cleanWithDocs = [
    'HEAD:abc1234',
    'FETCH_OK:1',
    'REF_OK:1',
    'BEHIND:0',
    'AHEAD:1',
    'CONFLICT_EXIT:0',
    'TREE_BEGIN',
    'See the CONFLICT section of the guide.',
    'TREE_END',
    '',
  ].join('\n');
  const clean = parseBranchFreshnessProbeOutput(cleanWithDocs, 'main', 'merge');
  assert.equal(clean.mergeConflicts, false);
  assert.equal(clean.behindMain, 0);
  assert.equal(clean.aheadMain, 1);

  // Missing CONFLICT_EXIT marker → fail closed (unknown), not false.
  const missingExit = [
    'HEAD:abc1234',
    'FETCH_OK:1',
    'REF_OK:1',
    'BEHIND:0',
    'AHEAD:1',
    'TREE_BEGIN',
    'TREE_END',
    '',
  ].join('\n');
  const incomplete = parseBranchFreshnessProbeOutput(missingExit, 'main', 'merge');
  assert.equal(incomplete.mergeConflicts, undefined);
});
test('sanitizeDefaultBranch and resolveBranchUpdateStrategy fail closed to safe defaults', () => {
  assert.equal(sanitizeDefaultBranch('main'), 'main');
  assert.equal(sanitizeDefaultBranch('release/1.2'), 'release/1.2');
  assert.equal(sanitizeDefaultBranch('main; rm -rf /'), 'main');
  assert.equal(resolveBranchUpdateStrategy({ merge_main_strategy: 'rebase' }), 'rebase');
  assert.equal(resolveBranchUpdateStrategy({ merge_main_strategy: 'merge' }), 'merge');
  assert.equal(resolveBranchUpdateStrategy({}), 'merge');
  assert.equal(resolveBranchUpdateStrategy(null), 'merge');
});

test('applyBranchFreshnessToReadyGatePayload clears stale keys (package-refresh wiring)', () => {
  const stale: ReadyGatePayload = {
    kind: 'ready',
    prNumber: null,
    repo: null,
    diffStat: { files: 1, additions: 1, deletions: 0 },
    workerReport: '',
    branch: 'feat/x',
    behindMain: 21,
    mergeConflicts: true,
    mergeConflictPaths: ['f.ts'],
    branchFreshnessHint: 'behindMain: 21, mergeConflicts: true. Next: git merge origin/main',
  };

  const cleaned = applyBranchFreshnessToReadyGatePayload(stale, {
    behindMain: 0,
    aheadMain: 1,
    mergeConflicts: false,
    mergeConflictPaths: [],
    defaultBranch: 'main',
    remoteRefOk: true,
    fetchOk: true,
    hint: 'Branch is up to date with origin/main (behindMain: 0, mergeConflicts: false).',
  });
  assert.equal(cleaned.mergeConflicts, false);
  assert.equal(cleaned.behindMain, 0);
  assert.match(cleaned.branchFreshnessHint ?? '', /up to date/);
  // Stale path sample must not survive (assert before deepEqual so [] does not
  // narrow mergeConflictPaths to never[] under assert.deepEqual's type predicate).
  assert.ok(!cleaned.mergeConflictPaths?.includes('f.ts'));
  assert.deepEqual(cleaned.mergeConflictPaths, [] as string[]);

  const cleared = applyBranchFreshnessToReadyGatePayload(stale, null);
  assert.equal(cleared.behindMain, undefined);
  assert.equal(cleared.mergeConflicts, undefined);
  assert.equal(cleared.mergeConflictPaths, undefined);
  assert.equal(cleared.branchFreshnessHint, undefined);
  // Other payload fields preserved.
  assert.equal(cleared.branch, 'feat/x');
  assert.equal(cleared.kind, 'ready');
});

/**
 * Real-git proof: write-tree exit status detects conflicts; missing remote ref
 * does not report mergeConflicts or aheadMain=0.
 */
test('real git: write-tree probe reports conflicts only when origin ref exists', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'branch-freshness-'));
  const bare = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
  execFileSync('git', ['clone', bare, work], { stdio: 'ignore' });
  const git = (args: string[], cwd = work) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['config', 'user.email', 't@t.com']);
  git(['config', 'user.name', 't']);
  writeFileSync(path.join(work, 'f.txt'), 'base\n');
  git(['add', 'f.txt']);
  git(['commit', '-m', 'base']);
  git(['branch', '-M', 'main']);
  git(['push', '-u', 'origin', 'main']);

  // Divergent tips that conflict on f.txt
  git(['checkout', '-b', 'feature']);
  writeFileSync(path.join(work, 'f.txt'), 'feature-side\n');
  git(['commit', '-am', 'feature']);
  git(['push', '-u', 'origin', 'feature']);

  git(['checkout', 'main']);
  writeFileSync(path.join(work, 'f.txt'), 'main-side\n');
  git(['commit', '-am', 'main-move']);
  git(['push', 'origin', 'main']);

  git(['checkout', 'feature']);
  const script = buildBranchFreshnessProbeScript(work, 'main');
  const stdout = execFileSync('bash', ['-lc', script], { encoding: 'utf8' });
  const summary = parseBranchFreshnessProbeOutput(stdout, 'main', 'merge');
  assert.equal(summary.mergeConflicts, true, `expected conflicts; probe out:\n${stdout}`);
  assert.ok((summary.behindMain ?? 0) >= 1, `expected behindMain>=1; got ${summary.behindMain}`);
  assert.ok(
    summary.mergeConflictPaths.some((p) => p.includes('f.txt')),
    `expected f.txt in paths; got ${JSON.stringify(summary.mergeConflictPaths)}`,
  );
  assert.equal(summary.remoteRefOk, true);
  assert.equal(typeof summary.aheadMain, 'number');

  // Clean pair after making main content match feature.
  git(['checkout', 'main']);
  writeFileSync(path.join(work, 'f.txt'), 'feature-side\n');
  git(['commit', '-am', 'main-matches-feature']);
  git(['push', 'origin', 'main']);
  git(['checkout', 'feature']);
  const cleanOut = execFileSync('bash', ['-lc', buildBranchFreshnessProbeScript(work, 'main')], {
    encoding: 'utf8',
  });
  const cleanSummary = parseBranchFreshnessProbeOutput(cleanOut, 'main', 'merge');
  assert.equal(
    cleanSummary.mergeConflicts,
    false,
    `expected clean merge; probe out:\n${cleanOut}`,
  );

  // Missing remote ref: delete origin/main tracking and probe a non-existent branch name.
  const missingOut = execFileSync('bash', [
    '-lc',
    buildBranchFreshnessProbeScript(work, 'does-not-exist-branch'),
  ], { encoding: 'utf8' });
  const missing = parseBranchFreshnessProbeOutput(missingOut, 'does-not-exist-branch', 'merge');
  assert.equal(missing.remoteRefOk, false, `probe out:\n${missingOut}`);
  assert.equal(missing.mergeConflicts, undefined);
  assert.equal(missing.aheadMain, undefined);
  assert.equal(missing.behindMain, undefined);

  // Failed fetch: point origin at a nonexistent path so fetch exits non-zero while a
  // stale origin/main tracking ref may still exist — must not report behindMain:0 clean.
  git(['remote', 'set-url', 'origin', path.join(root, 'gone.git')]);
  const failFetchOut = execFileSync('bash', ['-lc', buildBranchFreshnessProbeScript(work, 'main')], {
    encoding: 'utf8',
  });
  const failFetch = parseBranchFreshnessProbeOutput(failFetchOut, 'main', 'merge');
  assert.equal(failFetch.fetchOk, false, `probe out:\n${failFetchOut}`);
  assert.equal(failFetch.remoteRefOk, false);
  assert.equal(failFetch.behindMain, undefined);
  assert.equal(failFetch.mergeConflicts, undefined);
  assert.match(failFetch.hint, /fetch origin main failed/);
  assert.doesNotMatch(failFetch.hint, /up to date/);
});