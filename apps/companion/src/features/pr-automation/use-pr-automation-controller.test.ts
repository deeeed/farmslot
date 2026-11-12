import assert from 'node:assert/strict';
import test from 'node:test';

import * as protocol from '@farmslot/protocol';
import * as clientCache from '@farmslot/protocol/client-cache';
import * as reviewDispatch from '@farmslot/review-dispatch';

import { mountHook } from '../../hooks/hook-harness.fixtures';
import * as prAutomation from '../../lib/pr-automation';

import type { PRAutomationController } from './use-pr-automation-controller';

type PRReviewIntent = protocol.PRReviewIntent;
type Run = protocol.Run;
type RunGetResult = protocol.RunGetResult;
type RunListRow = protocol.RunListRow;
type ResourceQuery = clientCache.ResourceQuery;
type RunGetState = clientCache.ResourceQueryState<RunGetResult>;

const { Methods, runListRow } = protocol;
const headSha = 'a'.repeat(40);
const settle = async () => {
  for (let index = 0; index < 20; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

const intent: PRReviewIntent = {
  id: 'intent-1',
  pr: { host: 'github.com', repo: 'owner/repo', number: 42 },
  headSha,
  reviewProfile: 'default',
  status: 'completed',
  runId: 'review',
  contributions: [
    {
      submissionId: 'submission-1',
      submissionRevision: 1,
      teamId: 'team-1',
      teamRevision: 1,
      ownerId: 'owner',
      reasons: [],
      project: 'project',
      autoStart: false,
      eligible: true,
      configurationErrors: [],
    },
  ],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:10:00.000Z',
};

/** A finished review of the intent's head, owned by the signed-in person. */
function reviewRun(fields: Partial<Run> = {}): Run {
  return {
    id: 'review',
    familyId: 'family-review',
    lane: 'production',
    flowType: 'review-pr',
    status: 'done',
    project: 'project',
    ticketOrPr: 'owner/repo#42',
    slotId: null,
    branch: null,
    taskFile: null,
    createdByPrincipalId: 'owner',
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    reviewResult: {
      recommendation: 'COMMENT',
      reviewMd: 'Review complete',
      lineComments: [],
      reviewSnapshot: { headSha, source: 'github-pr', capturedAt: '2026-11-01T00:09:00.000Z' },
    },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:10:00.000Z',
    ...fields,
  };
}

/** The PR automation controller over a shared cache that holds, reads or refuses run.get. */
function qaWorld({
  held,
  read,
}: {
  /** The run.get the offline store holds, if any. */
  held?: Run;
  /** What a run.get read answers: a run, or an error message. */
  read?: Run | string;
}) {
  const reads: string[] = [];
  let release: (() => void) | undefined;
  const world = {
    reads,
    /** Hold the next run.get read open until `release()`. */
    hold: false,
    release: () => release?.(),
  };
  const listData: Record<string, unknown> = {
    [Methods.PR_WATCH_LIST]: { monitors: [] },
    [Methods.PR_RULES_LIST]: { teams: [], rules: [], intents: [intent] },
    [Methods.DISPATCH_QUEUE_LIST]: { items: [] },
    [Methods.PR_PUSH_LIST]: { attention: [], devices: [], deliveries: [] },
  };
  const listStates = new Map<string, { status: 'ready'; data: unknown }>();
  const listState = (query: ResourceQuery) => {
    const state = listStates.get(query.id) ?? { status: 'ready', data: listData[query.method] };
    listStates.set(query.id, state);
    return state;
  };
  const cache = {
    read: listState,
    async readStored(query: ResourceQuery): Promise<RunGetState> {
      assert.equal(query.method, Methods.RUN_GET);
      return held ? { status: 'ready', data: { run: held } } : { status: 'loading' };
    },
    async retry(query: ResourceQuery): Promise<RunGetState> {
      reads.push(`${query.method}:${JSON.stringify(query.params)}`);
      if (world.hold) await new Promise<void>((resolve) => (release = resolve));
      if (read === undefined) assert.fail('No run.get read is expected');
      return typeof read === 'string'
        ? { status: 'error', error: { code: 'UNAVAILABLE', message: read } }
        : { status: 'ready', data: { run: read } };
    },
  };
  const client = { connectionGeneration: 1, connectionState: 'connected' };
  const connection = {
    client,
    status: 'connected',
    activeProfileId: 'profile-a',
    activeProfileHttpAuthHeaders: {},
    principalId: 'owner',
  };
  const store = <State>(state: State) =>
    Object.assign((select: (value: State) => unknown) => select(state), {
      getState: () => state,
    });
  const pushDevice = { error: '', setError() {} };
  const hook = mountHook<[]>(
    new URL('./use-pr-automation-controller.ts', import.meta.url),
    'usePRAutomationController',
    {
      'expo-router': { useRouter: () => ({ push() {} }) },
      'react-native': {
        Linking: { addEventListener: () => ({ remove() {} }), openURL: async () => undefined },
      },
      '@farmslot/protocol': protocol,
      '@farmslot/protocol/client-cache': clientCache,
      '@farmslot/review-dispatch': reviewDispatch,
      '../../components/view-state': {
        useViewChoice: () => ['reviews', () => undefined],
        useViewToggle: () => [false, () => undefined],
      },
      '../../hooks/useConfigurationProjects': {
        useConfigurationProjects: () => ({ data: { projects: [] } }),
      },
      '../../hooks/useResourceQuery': { useResourceQuery: listState },
      '../../lib/configuration-resources': { readConfiguration: async () => ({ projects: [] }) },
      '../../lib/pr-automation': prAutomation,
      '../../lib/pr-push-device': {
        prPushInstallation: async () => 'installation-1',
        registerPRPushDevice: async () => undefined,
        usePRPushDeviceState: store(pushDevice),
      },
      '../../lib/resource-cache': { getResourceCache: () => cache },
      '../../lib/resource-read-status': { readErrorMessage: () => undefined },
      '../../store/attention-prefs': { useAttentionPrefsStore: store({}) },
      '../../store/connection': { useConnectionStore: store(connection) },
      '../../store/fleet': { useFleetStore: store({ fleet: { slots: [] } }) },
      '../../store/held-connection': { heldConnectionCurrent: () => true },
      '../../store/runs': { useRunStore: store({ runs: [] }) },
    },
  );
  const render = () => hook.render() as PRAutomationController;
  render();
  return Object.assign(world, {
    viewModel: () => render().viewModel,
    /** Press Run QA on the review card, which hands over the run.list row. */
    pressQA(row: RunListRow | undefined) {
      render().actions.openQA(intent, row);
    },
  });
}

test('Run QA links the source review from a held run.get that is current, without a read', async () => {
  const run = reviewRun();
  const world = qaWorld({ held: run });
  world.pressQA(runListRow(run));
  await settle();
  const viewModel = world.viewModel();
  assert.equal(viewModel.editor?.kind, 'request');
  assert.deepEqual(viewModel.requestDraft.sourceReview, {
    runId: 'review',
    url: 'https://github.com/owner/repo/pull/42',
  });
  assert.deepEqual(world.reads, []);
  assert.equal(viewModel.busy, false);
  assert.equal(viewModel.actionError, '');
});

test('Run QA reads run.get once when no current detail is held, then links the source review', async () => {
  const run = reviewRun();
  for (const held of [undefined, reviewRun({ updatedAt: '2026-11-01T00:05:00.000Z' })]) {
    const world = qaWorld({ held, read: run });
    world.hold = true;
    world.pressQA(runListRow(run));
    await settle();
    // The read is in flight: the screen is busy and a second press starts nothing.
    assert.equal(world.viewModel().busy, true);
    assert.equal(world.viewModel().editor, undefined);
    world.pressQA(runListRow(run));
    world.release();
    await settle();
    const viewModel = world.viewModel();
    assert.deepEqual(world.reads, ['run.get:{"runId":"review"}']);
    assert.equal(viewModel.editor?.kind, 'request');
    assert.equal(viewModel.requestDraft.sourceReview?.runId, 'review');
    assert.equal(viewModel.busy, false);
  }
});

test('Run QA opens no draft when run.get cannot be read, and shows why', async () => {
  const run = reviewRun();
  const world = qaWorld({ read: 'Gateway unavailable' });
  world.pressQA(runListRow(run));
  await settle();
  const failed = world.viewModel();
  assert.equal(failed.editor, undefined);
  assert.equal(failed.requestDraft.sourceReview, undefined);
  assert.equal(failed.actionError, 'Gateway unavailable');
  // The action stays available: the next press reads again.
  assert.equal(failed.busy, false);
  world.pressQA(runListRow(run));
  await settle();
  assert.equal(world.reads.length, 2);
});

test('Run QA opens an unlinked draft for a review of another head or a stale one, as before', async () => {
  const other = reviewRun({
    reviewResult: {
      recommendation: 'COMMENT',
      reviewMd: 'Review complete',
      lineComments: [],
      reviewSnapshot: {
        headSha: 'b'.repeat(40),
        source: 'github-pr',
        capturedAt: '2026-11-01T00:09:00.000Z',
      },
    },
  });
  const stale = reviewRun({
    reviewResult: undefined,
    decisions: [
      {
        id: 'posting',
        type: 'engine_review_posting',
        title: 'Post review',
        description: '',
        createdAt: '2026-11-01T00:09:00.000Z',
        resolvedAt: '2026-11-01T00:10:00.000Z',
        actions: [],
        payload: {
          kind: 'review',
          prNumber: 42,
          repo: 'owner/repo',
          recommendation: 'COMMENT',
          reviewMd: 'Review complete',
          lineComments: [],
          reviewSnapshot: { headSha, source: 'github-pr', capturedAt: '2026-11-01T00:09:00.000Z' },
          stale: true,
        },
      },
    ],
  });
  for (const run of [other, stale]) {
    const world = qaWorld({ held: run });
    world.pressQA(runListRow(run));
    await settle();
    const viewModel = world.viewModel();
    assert.equal(viewModel.editor?.kind, 'request');
    assert.equal(viewModel.requestDraft.sourceReview, undefined);
    assert.equal(viewModel.requestDraft.review.workflow, 'qa');
  }
  // No run for the intent: an unlinked draft, and nothing is read.
  const world = qaWorld({});
  world.pressQA(undefined);
  await settle();
  assert.equal(world.viewModel().editor?.kind, 'request');
  assert.deepEqual(world.reads, []);
});
