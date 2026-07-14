import assert from 'node:assert/strict';
import test from 'node:test';

import {
  githubPullUrl,
  parseGitHubRef,
  prNumberFromRunInput,
} from '../../src/integrations/github-ref.js';

test('parseGitHubRef parses canonical owner/repo number refs', () => {
  assert.deepEqual(parseGitHubRef('example-org/example-mobile#29655'), {
    repo: 'example-org/example-mobile',
    number: 29655,
    ref: 'example-org/example-mobile#29655',
  });
});

test('parseGitHubRef rejects non-canonical refs', () => {
  assert.equal(parseGitHubRef('PROJ-29655'), null);
  assert.equal(parseGitHubRef('example-org/example-mobile/issues/29655'), null);
  assert.equal(parseGitHubRef('owner/repo#not-a-number'), null);
  assert.equal(parseGitHubRef('owner/../repo#123'), null);
  assert.equal(parseGitHubRef('../../src/repo#123'), null);
});

test('githubPullUrl formats parsed refs as PR URLs', () => {
  const ref = parseGitHubRef('owner/repo#123');
  assert(ref);
  assert.equal(githubPullUrl(ref), 'https://github.com/owner/repo/pull/123');
});

test('prNumberFromRunInput derives PR-bound flow numbers from canonical refs', () => {
  assert.equal(prNumberFromRunInput({ flowType: 'review-pr', ticketOrPr: 'owner/repo#123' }), 123);
  assert.equal(
    prNumberFromRunInput({ flowType: 'pr-complete', ticketOrPr: 'owner/repo#456' }),
    456,
  );
  assert.equal(
    prNumberFromRunInput({ flowType: 'update-branch', ticketOrPr: 'owner/repo#789' }),
    789,
  );
});

test('prNumberFromRunInput honors explicit numbers and ignores non-PR flows', () => {
  assert.equal(
    prNumberFromRunInput({ flowType: 'fix-bug', ticketOrPr: 'owner/repo#123', prNumber: 987 }),
    987,
  );
  assert.equal(prNumberFromRunInput({ flowType: 'fix-bug', ticketOrPr: 'owner/repo#123' }), null);
});
