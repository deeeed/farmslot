import assert from 'node:assert/strict';
import test from 'node:test';

import { runContractSection } from './run-contract.js';

test('autonomous dev and fix-bug runs get the run contract', () => {
  for (const flow of ['dev', 'fix-bug']) {
    const section = runContractSection(flow, 'autonomous', 'temp/tasks/fix/t-1');
    assert.ok(section);
    assert.match(section, /^## Run contract\n/);
    assert.match(section, /`temp\/tasks\/fix\/t-1\/mark blocked --reason "…"`/);
    assert.match(section, /Commit the change locally with a Conventional Commit/);
    assert.match(section, /Never `git push` and never run a `gh pr` write/);
    assert.match(section, /Never mention Claude, AI or LLM/);
  }
});

test('interactive, validation and other flows get no run contract', () => {
  assert.equal(runContractSection('dev', 'interactive', 'temp/tasks/t'), null);
  assert.equal(runContractSection('fix-bug', 'validation', 'temp/tasks/t'), null);
  assert.equal(runContractSection('fix-bug', undefined, 'temp/tasks/t'), null);
  for (const flow of ['review-pr', 'pr-complete', 'qa', 'ci-fix', 'update-branch']) {
    assert.equal(runContractSection(flow, 'autonomous', 'temp/tasks/t'), null);
  }
});
