import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import type { AcceptanceCriterionView } from '@farmslot/protocol';

import {
  criterionDraftApprovalLabel,
  CriterionDraftModel,
  criterionDraftReason,
} from '../src/criterion-drafts.js';
import { acceptanceClaimRows } from '../src/publication-gate.js';

const claim: AcceptanceCriterionView = {
  id: 'AC-2',
  text: 'One configuration definition',
  status: {
    id: 'AC-2',
    text: 'One configuration definition',
    verdict: 'awaiting-review',
    proofMode: 'review',
    evidence: [],
    recipeNodes: [],
  },
};
const load = async (
  model: CriterionDraftModel,
  scope = 'person/run/gate',
  snapshot = 'package-a',
) => {
  model.setScope(scope, snapshot);
  await setImmediate();
  assert.equal(model.ready, true);
};

test('Confirm and Skip update immediately, survive reload and Undo without writing an engine verdict', async () => {
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  const model = new CriterionDraftModel(storage);
  await load(model);
  const original = structuredClone(claim);
  model.choose(claim, 'confirm', 'One exported address.', 'execution');
  assert.equal(
    acceptanceClaimRows({ claims: [claim], criterionDrafts: model.entries })[0].state,
    'Verified in code',
  );
  assert.equal(
    criterionDraftReason(model.entries),
    'AC-2: Confirmed in code review. One exported address.',
  );
  await model.settled();
  const reloaded = new CriterionDraftModel(storage);
  await load(reloaded);
  assert.deepEqual(reloaded.entries, model.entries);
  reloaded.choose(claim, 'skip', '', 'execution');
  assert.equal(
    acceptanceClaimRows({ claims: [claim], criterionDrafts: reloaded.entries })[0].state,
    'Skipped',
  );
  assert.equal(reloaded.entries[0].note, 'Not testable in this run.');
  assert.equal(
    criterionDraftApprovalLabel(reloaded.entries),
    'Approve with 0 confirmed, 1 skipped',
  );
  reloaded.undo('AC-2');
  assert.deepEqual(reloaded.entries, []);
  assert.deepEqual(claim, original);
  await reloaded.settled();
  const afterUndo = new CriterionDraftModel(storage);
  await load(afterUndo);
  assert.deepEqual(afterUndo.entries, []);
});

test('a failed draft save reverts the row and retains a visible retry of the intended choice', async () => {
  let fail = true;
  const model = new CriterionDraftModel({
    getItem: () => null,
    setItem: () => {
      if (fail) throw new Error('Storage full');
    },
  });
  await load(model);
  model.choose(claim, 'confirm');
  assert.equal(model.entries.length, 1, 'the press does not await storage');
  await model.settled();
  assert.equal(model.entries.length, 0);
  assert.equal(model.error?.message, 'Storage full');
  fail = false;
  model.error!.retry();
  await model.settled();
  assert.equal(model.entries.length, 1);
  assert.equal(model.error, null);
});

test('drafts cannot cross person, run, gate or frozen package boundaries', async () => {
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  const model = new CriterionDraftModel(storage);
  await load(model);
  model.choose(claim, 'confirm');
  await model.settled();
  for (const scope of ['other-person/run/gate', 'person/other-run/gate', 'person/run/other-gate']) {
    await load(model, scope);
    assert.deepEqual(model.entries, []);
  }
  await load(model, 'person/run/gate', 'package-b');
  assert.deepEqual(model.entries, []);
});

test('late stored data cannot replace the newly selected gate', async () => {
  let finish: (value: string | null) => void = () => {
    throw new Error('Read not installed');
  };
  const model = new CriterionDraftModel({
    getItem: (key) =>
      key.endsWith('old')
        ? new Promise<string | null>((resolve) => {
            finish = resolve;
          })
        : null,
    setItem: () => undefined,
  });
  model.setScope('old', 'package-a');
  await setImmediate();
  await load(model, 'new');
  finish(
    JSON.stringify({
      snapshot: 'package-a',
      entries: [{ claimId: 'AC-2', choice: 'confirm', note: 'Old gate', codeReview: true }],
    }),
  );
  await setImmediate();
  assert.deepEqual(model.entries, []);
});

test('an owning override response preserves remaining consent when its update event arrived first', async () => {
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  const model = new CriterionDraftModel(storage);
  await load(model);
  model.choose(claim, 'confirm');
  await model.settled();
  const consent = [...model.entries];
  model.setScope('person/run/gate', 'package-b');
  model.rebind('package-b', 'AC-3', consent);
  await model.settled();
  await setImmediate();
  assert.deepEqual(model.entries, consent);
  const reloaded = new CriterionDraftModel(storage);
  await load(reloaded, 'person/run/gate', 'package-b');
  assert.deepEqual(reloaded.entries, consent);
});

function approvalGate(): import('@farmslot/protocol').RunDecision {
  return {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Review',
    description: 'Prepared package',
    createdAt: '2026-10-27T00:00:00Z',
    actions: [{ id: 'approve-publish-evidence-attested', label: 'Attest', style: 'danger' }],
  };
}

test('one approval owns the pending draft and a second press sends no command', async () => {
  const model = new CriterionDraftModel({ getItem: () => null, setItem: () => undefined });
  await load(model);
  model.choose(claim, 'confirm');
  await model.settled();
  let complete: (value: string) => void = () => {
    throw new Error('Send was not started');
  };
  let sends = 0;
  const input: import('../src/criterion-drafts.js').CriterionDraftApproval<string> = {
    run: { id: 'run' },
    decision: approvalGate(),
    actionId: 'approve-publish-evidence-attested',
    reason: '',
    requestSkip: async () => {
      throw new Error('No skip was chosen');
    },
    applied: () => {
      throw new Error('No skip was chosen');
    },
    assertCurrent: () => undefined,
    send: async (_decision, _action, reason) => {
      sends++;
      assert.match(reason, /AC-2: Confirmed in code review/);
      return new Promise<string>((resolve) => {
        complete = resolve;
      });
    },
  };
  const pending = model.approve(input);
  await setImmediate();
  assert.equal(model.submissionActionId, 'approve-publish-evidence-attested');
  model.undo('AC-2');
  assert.equal(model.entries.length, 1);
  await assert.rejects(model.approve(input), /already being submitted/);
  assert.equal(sends, 1);
  complete('accepted');
  assert.equal(await pending, 'accepted');
  assert.deepEqual(model.entries, []);
  assert.equal(model.submissionActionId, null);
});

test('a reply for a detached gate cannot clear the new gate draft', async () => {
  const model = new CriterionDraftModel({ getItem: () => null, setItem: () => undefined });
  await load(model);
  model.choose(claim, 'confirm');
  await model.settled();
  let complete: (value: string) => void = () => {
    throw new Error('Send was not started');
  };
  const pending = model.approve({
    run: { id: 'run' },
    decision: approvalGate(),
    actionId: 'approve-publish-evidence-attested',
    reason: '',
    requestSkip: async () => {
      throw new Error('No skip');
    },
    applied: () => {
      throw new Error('No skip');
    },
    assertCurrent: () => undefined,
    send: async () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  });
  const refused = assert.rejects(pending, /gate or signed-in authority changed/);
  await setImmediate();
  model.deactivate();
  await load(model, 'other-person/run/gate');
  model.choose(claim, 'skip', 'A different gate', 'execution');
  await model.settled();
  complete('old reply');
  await refused;
  assert.equal(model.entries[0].choice, 'skip');
  assert.equal(model.entries[0].note, 'A different gate');
});
