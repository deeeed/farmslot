import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBranchFreshnessProbeScript,
  formatBranchFreshnessHint,
  parseBranchFreshnessProbeOutput,
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

test('parseMergeTreeConflicts detects markers and CONFLICT lines with path samples', () => {
  const clean = parseMergeTreeConflicts('merged\n  result 100644 abc path/file.ts\n');
  assert.equal(clean.mergeConflicts, false);
  assert.deepEqual(clean.paths, []);

  const marked = parseMergeTreeConflicts(
    ['<<<<<<< .our', 'ours', '=======', 'theirs', '>>>>>>> .their', ''].join('\n'),
  );
  assert.equal(marked.mergeConflicts, true);

  const conflictLine = parseMergeTreeConflicts(
    'CONFLICT (content): Merge conflict in apps/command-center/ui/src/gate.ts\n',
  );
  assert.equal(conflictLine.mergeConflicts, true);
  assert.ok(conflictLine.paths.some((p) => p.includes('gate.ts')));
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

test('buildBranchFreshnessProbeScript is non-destructive (no rebase/push/force)', () => {
  const script = buildBranchFreshnessProbeScript('/tmp/slot-repo', 'main');
  assert.match(script, /git -C .* fetch origin main/);
  assert.match(script, /rev-list --count "HEAD\.\.origin\/main"/);
  assert.match(script, /merge-tree/);
  assert.doesNotMatch(script, /rebase/);
  assert.doesNotMatch(script, /push/);
  assert.doesNotMatch(script, /force-with-lease/);
  assert.doesNotMatch(script, /--force/);
});

test('parseBranchFreshnessProbeOutput wires behindMain + mergeConflicts soft fields', () => {
  const stdout = [
    'BEHIND:21',
    'TREE_BEGIN',
    'CONFLICT (content): Merge conflict in services/gateway/src/x.ts',
    '<<<<<<< .our',
    '=======',
    '>>>>>>> .their',
    'TREE_END',
    '',
  ].join('\n');
  const summary = parseBranchFreshnessProbeOutput(stdout, 'main', 'merge');
  assert.equal(summary.behindMain, 21);
  assert.equal(summary.mergeConflicts, true);
  assert.ok(summary.mergeConflictPaths.some((p) => p.includes('x.ts')));
  assert.equal(summary.defaultBranch, 'main');
  assert.match(summary.hint, /git merge origin\/main/);
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
