import assert from 'node:assert/strict';
import test from 'node:test';

import * as protocol from '@farmslot/protocol';
import * as reviewDispatch from '@farmslot/review-dispatch';

import { mountHook } from './hook-harness.fixtures';
import type { useGateCriterionDrafts } from './useGateCriterionDrafts';

type DraftState = ReturnType<typeof useGateCriterionDrafts>;
type Approval = reviewDispatch.CriterionDraftApproval<unknown>;

const { APPROVE_PUBLISH_ACTION, HUMAN_GATE_DECISION_TYPE, Methods } = protocol;
const decision = {
  id: 'gate-1',
  type: HUMAN_GATE_DECISION_TYPE,
  title: 'Publish',
  description: 'Prepared package',
  createdAt: '2026-10-28T00:00:00.000Z',
  actions: [{ id: APPROVE_PUBLISH_ACTION, label: 'Approve', style: 'primary' }],
  payload: { kind: 'ready', prPackage: { id: 'package', packageHash: 'pkg-1', headSha: 'head-1' } },
} as unknown as protocol.RunDecision;

/** The draft hook with a model that hands the skip transport whatever method a test chooses. */
function draftsWorld(skipMethod: string) {
  const sent: string[] = [];
  const client = {
    authenticatedPrincipal: { id: 'operator', subjectKind: 'person' },
    request: async (method: string) => {
      sent.push(method);
      return { ok: true };
    },
  };
  const state = { client, authorityEpoch: 0, gatewayUrl: 'ws://gate.invalid' };
  const model = {
    entries: [{ claimId: 'AC-2', choice: 'skip', note: 'Not testable here.', codeReview: false }],
    scopeVersion: 0,
    approve: (input: Approval) =>
      Promise.resolve().then(() =>
        input.requestSkip(skipMethod, {
          runId: 'run-1',
          decisionId: decision.id,
          claimId: 'AC-2',
          recipeRunId: 'recipe-1',
          reason: 'Not testable here.',
          snapshotIdentity: 'pkg-1',
        }),
      ),
  };
  const hook = mountHook<[unknown]>(
    new URL('./useGateCriterionDrafts.ts', import.meta.url),
    'useGateCriterionDrafts',
    {
      'react-native': { Alert: { alert: () => assert.fail('No alert expected') } },
      '@farmslot/protocol': protocol,
      '@farmslot/review-dispatch': reviewDispatch,
      '../store/connection': {
        useConnectionStore: Object.assign(
          (select: (value: typeof state) => unknown) => select(state),
          { getState: () => state },
        ),
      },
      './useCriterionDrafts': { useCriterionDrafts: () => model },
    },
  );
  const drafts = hook.render({ runId: 'run-1', decision, client }) as DraftState;
  const submit = () =>
    drafts.submit({
      run: { id: 'run-1', decisions: [decision] } as unknown as protocol.Run,
      decision,
      actionId: APPROVE_PUBLISH_ACTION,
      reason: '',
      applied: () => undefined,
    });
  return { sent, submit };
}

// Pins requestSkip's literal transport: only run.overrideClaim is sent; any other method is refused.
test('a criterion skip sends only run.overrideClaim and refuses any other method', async () => {
  const allowed = draftsWorld(Methods.RUN_OVERRIDE_CLAIM);
  await allowed.submit();
  assert.deepEqual(allowed.sent, [Methods.RUN_OVERRIDE_CLAIM]);

  const refused = draftsWorld(Methods.RUN_RESOLVE_DECISION);
  await assert.rejects(refused.submit(), /Invalid criterion override request/);
  assert.deepEqual(refused.sent, [], 'a skip never sends another write');
});
