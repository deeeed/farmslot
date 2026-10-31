import assert from 'node:assert/strict';
import test from 'node:test';

import * as protocol from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import * as reviewDispatch from '@farmslot/review-dispatch';

import { mountHook } from '../../hooks/hook-harness.fixtures';
import * as connectionAuthority from '../../lib/connection-authority';
import * as decisionResolve from '../../lib/decision-resolve';
import { readErrorMessage } from '../../lib/resource-read-status';

import type { GateReviewScreenState, useGateReviewController } from './use-gate-review-controller';

type Run = protocol.Run;
type RunDecision = protocol.RunDecision;
type Controller = ReturnType<typeof useGateReviewController>;
type ReadyViewModel = Extract<GateReviewScreenState, { status: 'ready' }>['viewModel'];
interface AlertButton {
  text: string;
  onPress?: () => void;
}
interface Request {
  method: string;
  params: Record<string, unknown>;
}

const { acceptanceCriterionId, APPROVE_PUBLISH_ACTION, HUMAN_GATE_DECISION_TYPE, Methods } =
  protocol;
const params = { runId: 'run-1', decisionId: 'gate-1' };
const confirmId = acceptanceCriterionId(0);
const skipId = acceptanceCriterionId(1);
const settle = async () => {
  for (let index = 0; index < 20; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

function gateDecision(packageHash: string): RunDecision {
  return {
    id: params.decisionId,
    type: HUMAN_GATE_DECISION_TYPE,
    title: 'Publish',
    description: 'Prepared package',
    createdAt: '2026-10-28T00:00:00.000Z',
    actions: [{ id: APPROVE_PUBLISH_ACTION, label: 'Approve', style: 'primary' }],
    payload: {
      kind: 'ready',
      acceptanceCriteria: ['Shows the banner', 'Works on a cold start'],
      prPackage: { id: 'package', packageHash, headSha: 'head-1' },
    },
  } as unknown as RunDecision;
}

/** One gate on screen, read from the shared cache, with the real controller and draft hooks. */
function gateWorld({ online = true, runBound = true } = {}) {
  const run = { id: params.runId, slotId: 's1', decisions: [gateDecision('pkg-1')] } as Run;
  const sent: Request[] = [];
  const alerts: Array<{ title: string; message?: string; buttons?: AlertButton[] }> = [];
  let haptics = 0;
  let held: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  const client = {
    connectionGeneration: 1,
    connectionState: online ? 'connected' : 'disconnected',
    workspaceAccess: 'farm',
    authenticatedPrincipal: { id: 'operator', subjectKind: 'person' },
    hold: false,
    request(method: string, requestParams: Record<string, unknown>) {
      sent.push({ method, params: requestParams });
      if (method === Methods.RUN_OVERRIDE_CLAIM) {
        const next = gateDecision('pkg-2');
        return Promise.resolve({
          run: { ...run, decisions: [next] },
          receipt: { claimId: requestParams.claimId, reason: requestParams.reason },
        });
      }
      if (!client.hold) return Promise.resolve({ ok: true });
      return new Promise((resolve, reject) => {
        held = { resolve, reject };
      });
    },
  };
  const state = {
    client,
    status: online ? 'connected' : 'disconnected',
    activeProfileId: 'profile-a',
    authorityEpoch: 0,
    gatewayUrl: 'ws://gate.invalid',
    activeProfileHttpAuthHeaders: {},
  };
  const store = Object.assign((select: (value: typeof state) => unknown) => select(state), {
    getState: () => state,
  });
  // Device-local draft storage, as AsyncStorage holds it; no gateway read is involved.
  const saved = new Map<string, string>();
  const drafts = new reviewDispatch.CriterionDraftModel({
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  });
  const world = {
    run,
    client,
    sent,
    alerts,
    drafts,
    decisionsCurrent: online,
    get haptics() {
      return haptics;
    },
    get held() {
      return held;
    },
  };
  const alert = {
    alert: (title: string, message?: string, buttons?: AlertButton[]) =>
      alerts.push({ title, message, buttons }),
  };
  const evidenceModel = { claimOverrideCandidate: () => ({ recipeRunId: 'recipe-1' }) };
  const gate = {
    acceptance: { evidenceModel, loading: false, recipeRunId: 'recipe-1', commandsReady: online },
    reviews: [],
    guard: {},
    actions: [{ id: APPROVE_PUBLISH_ACTION, label: 'Approve', disabledReason: null }],
  };
  const draftsHook = mountHook<[unknown]>(
    new URL('../../hooks/useGateCriterionDrafts.ts', import.meta.url),
    'useGateCriterionDrafts',
    {
      'react-native': { Alert: alert },
      '@farmslot/protocol': protocol,
      '@farmslot/review-dispatch': reviewDispatch,
      '../store/connection': { useConnectionStore: store },
      './useCriterionDrafts': {
        useCriterionDrafts: (scope: string, snapshot: string) => {
          drafts.setScope(scope, snapshot);
          return drafts;
        },
      },
    },
  );
  const controller = mountHook<[typeof params]>(
    new URL('./use-gate-review-controller.ts', import.meta.url),
    'useGateReviewController',
    {
      'expo-haptics': {
        notificationAsync: async () => {
          haptics++;
        },
        NotificationFeedbackType: { Success: 'success' },
      },
      'expo-router': { useRouter: () => ({ push() {}, back() {} }) },
      'react-native': { Alert: alert },
      '@farmslot/protocol': protocol,
      '@farmslot/protocol/client-cache': { resourceQuery },
      '@farmslot/review-dispatch': {
        ...reviewDispatch,
        gateReviewLineageOptions: () => undefined,
        reviewLineagesForRun: () => [],
        reviewRequestContextForRun: () => undefined,
      },
      '../../hooks/useConnectedTransport': { useConnectedTransport: () => (online ? 1 : null) },
      '../../hooks/useGateCriterionDrafts': {
        useGateCriterionDrafts: (input: unknown) => draftsHook.render(input),
      },
      '../../hooks/useHumanGateGuard': {
        useHumanGateGuard: (_client: unknown, current: unknown, decision: unknown) =>
          current && decision ? gate : null,
      },
      '../../hooks/useResourceQuery': {
        useResourceQuery: () => ({
          status: online ? 'ready' : 'stale',
          data: { run },
          observedAt: 1,
        }),
      },
      '../../lib/acceptance-evidence': { acceptanceEvidenceHref: () => '/' },
      '../../lib/artifact-url': { groupVisualArtifactPairs: () => ({ pairs: [] }) },
      '../../lib/claim-overrides': {
        requestClaimUntestableOverride: async () => assert.fail('Skips go through drafts'),
      },
      '../../lib/connection-authority': connectionAuthority,
      '../../lib/decision-resolve': decisionResolve,
      '../../lib/evidence-media-items': {
        evidenceMediaItems: () => [],
        recordedEvidenceArtifactUrl: () => '',
        selectedEvidenceMediaItem: () => ({}),
      },
      '../../lib/gate-review': { gateReviewSummary: () => ({}), HUMAN_GATE_DECISION_TYPE },
      '../../lib/resource-cache': { getResourceCache: () => undefined },
      '../../lib/review-budget': { requestAnotherReviewRound: async () => undefined },
      '../../lib/run-collections': {
        assertNativeDecisionReady: () => {
          if (!world.decisionsCurrent) throw new Error('Wait for current decisions before acting.');
        },
        assertNativeRunReady: () => undefined,
      },
      '../../store/connection': { useConnectionStore: store },
      '../../store/held-connection': { heldConnectionCurrent: () => true },
      '../../lib/resource-read-status': { readErrorMessage },
      '../../store/decisions': {
        useDecisionStore: (select: (value: { observation: unknown }) => unknown) =>
          select({ observation: { status: world.decisionsCurrent ? 'ready' : 'stale' } }),
      },
      '../decision-workspace/components/decision-workspace-panels': {
        decisionDetailFromRun: (current: Run, decision: RunDecision) => ({
          id: decision.id,
          type: decision.type,
          payload: decision.payload,
          ...(runBound ? { runMeta: { runId: current.id } } : {}),
        }),
      },
    },
  );
  const render = () => controller.render(params) as Controller;
  const viewModel = (): ReadyViewModel => {
    const current = render().state;
    assert.equal(current.status, 'ready');
    return (current as Extract<GateReviewScreenState, { status: 'ready' }>).viewModel;
  };
  /** Press the approve action, then Send on its confirmation. */
  const approve = () => {
    const action = viewModel().actions.find(({ id }) => id === APPROVE_PUBLISH_ACTION)!;
    render().actions.resolve(action);
    const confirmation = alerts.find(({ title }) => title === 'Confirm action');
    assert(confirmation, 'the approval asks for confirmation');
    alerts.length = 0;
    return () => confirmation.buttons!.find(({ text }) => text === 'Send')!.onPress!();
  };
  return { world, render, viewModel, approve, cleanup: () => controller.cleanup() };
}

// Pins the Send path's draft branch: `isPublishApprovalAction(...) && drafts ? draftState.submit`.
test('approving with confirm and skip drafts on a cached gate sends the skips, then the resolve', async () => {
  const { world, viewModel, approve, cleanup } = gateWorld();
  try {
    viewModel();
    await settle();
    viewModel().draftActions.choose(confirmId, 'confirm');
    viewModel().draftActions.choose(skipId, 'skip');
    assert.equal(world.drafts.entries.length, 2);
    await world.drafts.settled();

    const send = approve();
    send();
    await settle();
    assert.deepEqual(
      world.sent.map(({ method }) => method),
      [Methods.RUN_OVERRIDE_CLAIM, Methods.RUN_RESOLVE_DECISION],
    );
    assert.equal(world.sent[0].params.claimId, skipId);
    assert.equal(world.sent[0].params.recipeRunId, 'recipe-1');
    assert.equal(world.sent[1].params.decisionId, params.decisionId);
    assert.equal(world.sent[1].params.actionId, APPROVE_PUBLISH_ACTION);
    assert.equal(
      (world.sent[1].params.selectionData as { packageHash?: string }).packageHash,
      'pkg-2',
      'the approval binds to the package the skip returned',
    );
    assert.equal(world.drafts.entries.length, 0, 'an accepted approval clears its drafts');
    assert.equal(world.haptics, 1);
    assert.deepEqual(world.alerts, []);
  } finally {
    cleanup();
  }
});

// Pins the Send-time `assertNativeDecisionReady` / `assertNativeRunReady` re-check.
test('Send refuses a decision that is no longer current', async () => {
  const { world, approve, cleanup } = gateWorld();
  try {
    const send = approve();
    world.decisionsCurrent = false;
    send();
    await settle();
    assert.deepEqual(world.sent, []);
    assert.equal(world.alerts[0]?.title, 'Decision is not current');
    assert.equal(world.haptics, 0);
  } finally {
    cleanup();
  }
});

// Pins `currentConnection()` on the reply: haptics in `then`, the alert in `catch`.
test('an owner switch mid-request suppresses the reply alert and haptics', async () => {
  const { world, approve, cleanup } = gateWorld();
  world.client.hold = true;
  try {
    approve()();
    await settle();
    assert.equal(world.sent.length, 1);
    world.client.authenticatedPrincipal = { id: 'another-operator', subjectKind: 'person' };
    world.held!.resolve({ ok: true });
    await settle();
    assert.equal(world.haptics, 0, 'no success haptics for another owner');

    world.client.authenticatedPrincipal = { id: 'operator', subjectKind: 'person' };
    approve()();
    await settle();
    assert.equal(world.sent.length, 2);
    world.client.authenticatedPrincipal = { id: 'another-operator', subjectKind: 'person' };
    world.held!.reject(new Error('Gate already resolved'));
    await settle();
    assert.deepEqual(
      world.alerts.map(({ title }) => title),
      [],
      'no failure alert for another owner',
    );
  } finally {
    cleanup();
  }
});

// Pins `actionsCurrent` disabling actions while the drafts stay usable on held data.
test('choosing and undoing a draft work offline while approve stays disabled', async () => {
  const { world, viewModel, render, cleanup } = gateWorld({ online: false });
  try {
    viewModel();
    await settle();
    const offline = viewModel();
    assert.equal(offline.commandsReady, false);
    const approveAction = offline.actions.find(({ id }) => id === APPROVE_PUBLISH_ACTION)!;
    assert.equal(approveAction.disabledReason, 'Wait for current decisions before acting.');

    offline.draftActions.choose(confirmId, 'confirm');
    assert.equal(world.drafts.entries.length, 1, 'a draft is chosen on held data');
    offline.draftActions.model.undo(confirmId);
    assert.equal(world.drafts.entries.length, 0, 'and undone');

    render().actions.resolve(approveAction);
    await settle();
    assert.deepEqual(world.sent, []);
    assert.equal(world.alerts[0]?.title, 'Decision is not current');
  } finally {
    cleanup();
  }
});

// Pins the gate's literal transport: only run.resolveDecision is sent, any other confirmed method is refused.
test('a gate Send refuses any confirmed transport other than run.resolveDecision', async () => {
  const { world, approve, cleanup } = gateWorld({ runBound: false });
  try {
    approve()();
    await settle();
    assert.deepEqual(world.sent, [], 'decision.resolve is not sent from the gate');
    assert.equal(world.alerts[0]?.title, 'Failed to resolve');
    assert.match(world.alerts[0]?.message ?? '', /does not send decision\.resolve/);
    assert.equal(world.haptics, 0);
  } finally {
    cleanup();
  }
});
