import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import '../runtime/mock-pty.test-support.js';

import { reviewerScratchRule } from './review-agent.js';

test('static reviewer contract forbids launching validation and reads recorded CI evidence', () => {
  const contract = reviewerScratchRule('review-policy-guard');
  assert.match(contract, /static.code/i);
  assert.match(contract, /CI results|CI receipts/);
  assert.match(contract, /unverified/i);
  assert.doesNotMatch(contract, /Put probe tests|probe must sit|reviewer_recipe_replay\(|mkdir -p/);
});

for (const name of ['review.md', 'review-pr.md', 'review-pr.static.md']) {
  test(`${name} grants inspection of recorded evidence without validation execution`, () => {
    const markdown = readFileSync(
      new URL(`../../../../projects/farmslot-farm/templates/worker/${name}`, import.meta.url),
      'utf8',
    );
    const positive = markdown
      .split('\n')
      .filter((line) => !/do not|never|without/i.test(line))
      .join('\n');
    assert.doesNotMatch(
      positive,
      /(?:Run|Re-run|Execute|Install) (?:focused |affected |probe |the |author )?(?:tests|recipes?|builds?|dependencies|validation)|yarn (?:typecheck|test|build)|Typecheck \+ gateway tests.*\| yes|Live recipe re-validation.*required|Doctor \+ CDP.*check/i,
    );
  });
}

for (const name of [
  ...['dev.md', 'fix-bug.md', 'review-fix.md', 'pr-complete.md', 'update-branch.md'].map(
    (file) => `projects/farmslot-farm/templates/worker/${file}`,
  ),
  'templates/worker/ci-fix.md',
]) {
  test(`${name} declares an engine-owned local check`, () => {
    const markdown = readFileSync(new URL(`../../../../${name}`, import.meta.url), 'utf8');
    assert.match(markdown, /\[DETERMINISTIC: ci\.local_check\]/);
    assert.doesNotMatch(markdown, /yarn typecheck|src\/path\/to\/affected\.test\.ts/);
  });
}
