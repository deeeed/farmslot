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
    assert.match(
      section,
      /Recipe, recipe-library or action-contract mismatches never block: copy the closest recipe into the task, adapt to current actions and continue\./,
    );
    assert.match(
      section,
      /and stop only for missing credentials, a product decision the ticket does not settle, or a farm\/device failure outside the checkout\./,
    );
    assert.match(
      section,
      /Use testnet unless the dispatch asks for mainnet; never block over it\./,
    );
    assert.doesNotMatch(section, /consent|permission/i);
    assert.match(section, /Commit the change locally with a Conventional Commit/);
    assert.match(section, /Until Farmslot publishes the PR, never `git push`/);
    // CI-FIX.md, sent after publication, asks the same worker to push its fix.
    assert.match(section, /CI-FIX\.md, may include its own push step; follow it/);
    assert.match(section, /Never credit or attribute the work to an AI agent/);
    assert.match(
      section,
      /releasing the slot copies nothing back\. If you build a binary after the evidence capture, capture it again or publish it from this run\./,
    );
  }
});

test('artifact-only runs outside comparison replays get a contract that commits and never publishes', () => {
  for (const flowType of ['dev', 'fix-bug'] as const) {
    const section = runContractSection(
      { flowType, mode: 'autonomous', completionPolicy: 'artifact-only', lane: 'validation' },
      'temp/tasks/t',
    );
    assert.ok(section);
    assert.match(section, /Never pause or ask for input\./);
    assert.match(
      section,
      /Commit the change locally with a Conventional Commit\. This run is artifact-only/,
    );
    assert.match(section, /never `git push` and never run a `gh pr` write/);
    assert.doesNotMatch(section, /publication gate|CI-FIX\.md/);
  }
});

test('interactive, validation, comparison replay and other flows get no run contract', () => {
  assert.equal(runContractSection({ flowType: 'dev', mode: 'interactive' }, 'temp/tasks/t'), null);
  assert.equal(
    runContractSection({ flowType: 'fix-bug', mode: 'validation' }, 'temp/tasks/t'),
    null,
  );
  assert.equal(runContractSection({ flowType: 'fix-bug' }, 'temp/tasks/t'), null);
  assert.equal(
    runContractSection(
      {
        flowType: 'fix-bug',
        mode: 'autonomous',
        completionPolicy: 'artifact-only',
        lane: 'comparison',
      },
      'temp/tasks/t',
    ),
    null,
  );
  const otherFlows: FlowType[] = ['review-pr', 'pr-complete', 'qa', 'update-branch'];
  for (const flowType of otherFlows) {
    assert.equal(runContractSection({ flowType, mode: 'autonomous' }, 'temp/tasks/t'), null);
  }
});
