import assert from 'node:assert/strict';
import test from 'node:test';

import type { FlowType } from '@farmslot/protocol';

import { runContractSection } from './run-contract.js';

test('autonomous dev and fix-bug runs get the run contract', () => {
  for (const flowType of ['dev', 'fix-bug'] as const) {
    const section = runContractSection({ flowType, mode: 'autonomous' }, 'temp/tasks/fix/t-1');
    assert.ok(section);
    assert.match(section, /^## Run contract\n/);
    assert.match(section, /`temp\/tasks\/fix\/t-1\/mark blocked --reason "…"`/);
    assert.match(section, /Commit the change locally with a Conventional Commit/);
    assert.match(section, /Until Farmslot publishes the PR, never `git push`/);
    // CI-FIX.md, sent after publication, asks the same worker to push its fix.
    assert.match(section, /CI-FIX\.md, may include its own push step; follow it/);
    assert.match(section, /Never credit or attribute the work to an AI agent/);
  }
});

test('interactive, validation, artifact-only and other flows get no run contract', () => {
  assert.equal(runContractSection({ flowType: 'dev', mode: 'interactive' }, 'temp/tasks/t'), null);
  assert.equal(
    runContractSection({ flowType: 'fix-bug', mode: 'validation' }, 'temp/tasks/t'),
    null,
  );
  assert.equal(runContractSection({ flowType: 'fix-bug' }, 'temp/tasks/t'), null);
  assert.equal(
    runContractSection(
      { flowType: 'fix-bug', mode: 'autonomous', completionPolicy: 'artifact-only' },
      'temp/tasks/t',
    ),
    null,
  );
  const otherFlows: FlowType[] = ['review-pr', 'pr-complete', 'qa', 'update-branch'];
  for (const flowType of otherFlows) {
    assert.equal(runContractSection({ flowType, mode: 'autonomous' }, 'temp/tasks/t'), null);
  }
});
