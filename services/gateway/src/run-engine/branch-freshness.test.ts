import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildBranchFreshnessProbeScript,
  formatBranchFreshnessHint,
  parseBranchFreshnessProbeOutput,
  parseMergeTreeConflictPaths,
  parseMergeTreeConflicts,
  parseRevListCount,
  resolveBranchUpdateStrategy,
  sanitizeDefaultBranch,
} from './branch-freshness.js';

test('parseRevListCount accepts non-negative integers and rejects garbage', () => {
  assert.equal(parseRevListCount('21\n'), 21);
  assert.equal(parseRevListCount('0'), 0);
  assert.equal(parseRevListCount(' 3 '), 3);
  assert.equal(parseRevListCount('not-a-number'), 0);
  assert.equal(parseRevListCount(''), 0);
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

  // Docs that say "CONFLICT" must not flip path extraction or free-text detection.
  const docsOnly = 'See the CONFLICT section of the guide for details.\n';
  assert.deepEqual(parseMergeTreeConflictPaths(docsOnly), []);
  const structuredOnly = parseMergeTreeConflicts(docsOnly);
  assert.equal(structuredOnly.mergeConflicts, false);
});

test('formatBranchFreshnessHint prefers merge during open review loops', () => {
  const upToDate = formatBranchFreshnessHint({
    behindMain: 0,
    mergeConflicts: false,
    defaultBranch: 'main',
  });
  assert.match(upToDate, /behindMain: 0/);
  assert.match(upToDate, /up to date/);

  const behind = formatBranchFreshnessHint({
    behindMain: 21,
    mergeConflicts: false,
    defaultBranch: 'main',
    strategy: 'merge',
  });
  assert.match(behind, /behindMain: 21/);
  assert.match(behind, /git merge origin\/main/);
  assert.doesNotMatch(behind, /force-with-lease/);

  const conflicts = formatBranchFreshnessHint({
    behindMain: 3,
    mergeConflicts: true,
    mergeConflictPaths: ['a.ts', 'b.ts'],
    defaultBranch: 'main',
    strategy: 'merge',
  });
  assert.match(conflicts, /mergeConflicts: true/);
  assert.match(conflicts, /a\.ts/);
  assert.match(conflicts, /git merge origin\/main/);

  const rebase = formatBranchFreshnessHint({
    behindMain: 2,
    mergeConflicts: true,
    defaultBranch: 'main',
    strategy: 'rebase',
  });
  assert.match(rebase, /git rebase origin\/main/);
  assert.match(rebase, /force-with-lease only when the project already standardizes/);
});

test('buildBranchFreshnessProbeScript uses write-tree exit status and is non-destructive', () => {
  const script = buildBranchFreshnessProbeScript('/tmp/slot-repo', 'main');
  assert.match(script, /git -C .* fetch origin main/);
  assert.match(script, /rev-list --count "HEAD\.\.origin\/main"/);
  assert.match(script, /merge-tree --write-tree --name-only HEAD "origin\/main"/);
  assert.match(script, /CONFLICT_EXIT/);
  assert.doesNotMatch(script, /rebase/);
  assert.doesNotMatch(script, /push/);
  assert.doesNotMatch(script, /force-with-lease/);
  // bare --force is not used (force-with-lease only in operator hint text elsewhere)
  assert.equal(script.includes('--force'), false);
});

test('parseBranchFreshnessProbeOutput keys mergeConflicts off CONFLICT_EXIT not free text', () => {
  const withConflict = [
    'HEAD:abc1234',
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
  assert.match(summary.hint, /git merge origin\/main/);

  // Free-text "CONFLICT" in docs with clean exit must NOT report conflicts.
  const cleanWithDocs = [
    'HEAD:abc1234',
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

/**
 * Real-git proof: classic merge-tree markers are +<<<<<<< so exit-status write-tree
 * is the only reliable detector. This is the claim the recipe also runs.
 */
test('real git: write-tree probe reports mergeConflicts on conflicting branches only', () => {
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
  // feature is behind main and conflicts — run the production probe script.
  const script = buildBranchFreshnessProbeScript(work, 'main');
  const stdout = execFileSync('bash', ['-lc', script], { encoding: 'utf8' });
  const summary = parseBranchFreshnessProbeOutput(stdout, 'main', 'merge');
  assert.equal(summary.mergeConflicts, true, `expected conflicts; probe out:\n${stdout}`);
  assert.ok(summary.behindMain >= 1, `expected behindMain>=1; got ${summary.behindMain}`);
  assert.ok(
    summary.mergeConflictPaths.some((p) => p.includes('f.txt')),
    `expected f.txt in paths; got ${JSON.stringify(summary.mergeConflictPaths)}`,
  );

  // Clean pair: feature tip vs itself via a branch that has no divergence content.
  // Make a non-conflicting merge by resetting main content to match feature.
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
});
