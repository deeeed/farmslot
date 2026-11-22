import assert from 'node:assert/strict';
import test from 'node:test';

import { applyArtifactOnlyTaskPolicy } from './artifact-only.js';

// Eval run 9317844e shipped TASK.md lines naming `selected reference/base`,
// the gateway's placeholder for an unknown base, and the worker went looking
// for that ref in git history. With no base to name, the guardrails must drop
// the comparison lines instead of naming something that cannot be resolved.
test('artifact replay guardrails omit the comparison lines when no base is known', () => {
  const template = [
    '# Synthetic task',
    '',
    'Inspect `git diff main...HEAD`.',
    'Then read `git log main..HEAD` and `git log HEAD..main`.',
    'Check out the branch, or create it from `main` if needed.',
    '',
  ].join('\n');
  const rendered = applyArtifactOnlyTaskPolicy(template, { base: undefined });
  assert.ok(rendered.includes('## Artifact-only replay guardrails'));
  assert.equal(rendered.includes('comparison replay from'), false);
  assert.ok(rendered.includes('No replay base was recorded'));
  // The preamble forbids `main` as the baseline, so no instruction may still
  // name it: the template's own main-relative commands must be rewritten, not
  // left standing beside a guardrail that contradicts them.
  assert.equal(/git diff main/.test(rendered), false, rendered.slice(0, 600));
  assert.ok(rendered.includes('git diff'));
  // A range instruction is dropped, not answered with a different range: a step
  // that counts or records `git log -n 20 HEAD` would report the wrong commits.
  assert.equal(/git log/.test(rendered), false, rendered.slice(0, 600));
  assert.equal(rendered.includes('Then read'), false, 'the whole range line goes');
  // A bare `git diff` is the working-tree instruction and is fine; what must
  // never appear is a command whose ref argument is missing or a placeholder.
  assert.equal(/git (?:diff|log)\s+(?:`|$|\.\.)/m.test(rendered), false, rendered.slice(0, 600));
  assert.equal(rendered.includes('undefined'), false, rendered.slice(0, 600));
  assert.equal(rendered.includes('selected reference/base'), false, rendered.slice(0, 600));
});

test('artifact replay instructions preserve replacement patterns and the heading', () => {
  const base = "synthetic-$'-$&-$`-$$-$1";
  const template = '# Synthetic task\n\nInspect `git diff main...HEAD`.\n';
  const rendered = applyArtifactOnlyTaskPolicy(template, { base });
  assert.ok(rendered.startsWith('# Synthetic task\n\n## Artifact-only replay guardrails\n'));
  assert.ok(rendered.includes(`This task is an artifact-only comparison replay from \`${base}\`.`));
  assert.ok(rendered.includes(`Inspect \`git diff ${base}\`.`));
});

// Run 6562483b (pinned startRef): fix-bug step 7 said `git diff "$(git merge-base origin/main HEAD)"`
// beside a guardrail that forbids `main` as the baseline. The merge base matched the pin only
// by chance; the instruction must name the replay base.
test('artifact replay rewrites merge-base-with-main diffs to the replay base', () => {
  const template = [
    '# Synthetic task',
    '',
    'Review `git diff "$(git merge-base origin/main HEAD)"` and `git status --short`.',
    'Include untracked files (`git diff "$(git merge-base origin/develop HEAD)" && git status`).',
    'Count `git log --oneline $(git merge-base origin/main HEAD)..HEAD`.',
    '',
  ].join('\n');
  const pinned = applyArtifactOnlyTaskPolicy(template, { base: 'f6c148ef' });
  assert.equal(/merge-base/.test(pinned), false, pinned);
  assert.ok(pinned.includes('Review `git diff f6c148ef` and'));
  assert.ok(pinned.includes('(`git diff f6c148ef && git status`)'));
  assert.ok(pinned.includes('`git log --oneline f6c148ef..HEAD`'));
  const unpinned = applyArtifactOnlyTaskPolicy(template, { base: undefined });
  assert.ok(unpinned.includes('Review `git diff` and'));
});

// Dependent commands stay coherent: a variable holding the merge base, a range, and a
// substitution inside a larger quoted word.
test('artifact replay keeps merge-base dependent commands runnable', () => {
  const template = [
    '# Synthetic task',
    '',
    'review_merge_base="$(git merge-base origin/main HEAD)"',
    'git diff "$review_merge_base"',
    'git diff "$(git merge-base origin/main HEAD)"..HEAD',
    'echo "Base $(git merge-base origin/main HEAD)"',
    'git log $(git merge-base origin/release origin/hotfix)..HEAD',
    'git diff "$(git merge-base origin/main HEAD)" HEAD -- src',
    '',
  ].join('\n');
  const pinned = applyArtifactOnlyTaskPolicy(template, { base: 'f6c148ef' });
  assert.ok(pinned.includes('review_merge_base=f6c148ef'));
  assert.ok(pinned.includes('git diff f6c148ef..HEAD'));
  assert.ok(pinned.includes('echo "Base f6c148ef"'));
  assert.ok(
    pinned.includes('$(git merge-base origin/release origin/hotfix)'),
    'other merge-bases stay',
  );
  const unpinned = applyArtifactOnlyTaskPolicy(template, { base: undefined });
  for (const line of template.split('\n').slice(2, 8)) assert.ok(unpinned.includes(line), line);
  assert.ok(pinned.includes('git diff f6c148ef HEAD -- src'), 'a two-revision diff keeps both');
});
