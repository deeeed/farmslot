import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  AgentContext,
  EvalBlindTrial,
  NativeWorkerSessionBinding,
  Run,
  RunPrepareArtifact,
} from '@farmslot/protocol';

import type { RawProjectJson } from '../core/index.js';
import { isPinnedPrepareRun, prepareIsPinned } from '../projects/pinned-prepare-policy.js';

import {
  observedBuildFiles,
  observedRunwayArtifact,
  pinnedDispatchRefusal,
  prepareObservesBuild,
  replayResumesNativeWorker,
  shouldReroutePinnedReplayToPrepare,
} from './pinned-prepare.js';
import { makeRun } from './test-fixtures.js';

const BASE = '260bd3a5b20c3f9126510b7b71d0e5527f395b5d';
const comparison: Pick<Run, 'lane' | 'startRef' | 'flowType' | 'engineState'> = {
  lane: 'comparison',
  flowType: 'dev',
  startRef: { requestedRef: '260bd3a5' },
  engineState: {},
};
const mobile: RawProjectJson = { name: 'mobile', hooks: { artifact_check: 'probe' } };
const extension: RawProjectJson = { name: 'extension' };

test('pinned runs are comparison dev or fix-bug runs with a start, outside capsules', () => {
  assert.equal(isPinnedPrepareRun(comparison), true);
  assert.equal(isPinnedPrepareRun({ ...comparison, flowType: 'fix-bug' }), true);
  assert.equal(
    isPinnedPrepareRun({ ...comparison, lane: 'production' }),
    false,
    'a production run with a start ref (QA) is not pinned',
  );
  assert.equal(isPinnedPrepareRun({ ...comparison, startRef: null }), false, 'no start, no pin');
  assert.equal(
    isPinnedPrepareRun({ ...comparison, flowType: 'qa' }),
    false,
    'a proof trial is a comparison-lane QA run and runs no app build',
  );
  const blind: EvalBlindTrial = {
    version: 1,
    baseSha: BASE,
    problemDigest: 'digest',
    referenceCommits: [],
    referencePatchId: 'patch',
    forbiddenInputs: [],
  };
  const experiment: NonNullable<NonNullable<Run['engineState']>['evalExperiment']> = {
    experimentId: 'experiment',
    experimentKey: 'key',
    experimentManifestPath: 'manifest.json',
    packagePath: 'package',
    candidateStrategyFingerprint: 'fingerprint',
    trialId: 'trial',
    blind,
  };
  const capsule = { ...comparison, engineState: { evalExperiment: experiment } };
  assert.equal(
    isPinnedPrepareRun({
      ...comparison,
      engineState: {
        evalExperiment: { ...experiment, blind: { ...blind, executionPolicy: 'normal-slot' } },
      },
    }),
    true,
    'a normal-slot trial is pinned like any comparison run',
  );
  assert.equal(isPinnedPrepareRun(capsule), false, 'a capsule trial keeps its isolated base');
});

test('only a project that takes part pins its runs; an unreadable one refuses', () => {
  assert.equal(prepareIsPinned(comparison, mobile), true);
  assert.equal(prepareIsPinned(comparison, extension), false, 'Extension prepares as today');
  assert.equal(prepareIsPinned(comparison, undefined), true, 'a config that fails to load refuses');
  assert.equal(prepareIsPinned({ ...comparison, startRef: null }, undefined), false);
});

const artifact: RunPrepareArtifact = {
  kind: 'runway',
  slotId: 'macwork-mm-2',
  baseSha: BASE,
  runId: '41900351233',
  revision: BASE,
  platform: 'ios',
  installedAt: '2026-11-25T10:00:00.000Z',
  enforced: true,
};
const prepared: Pick<Run, 'slotId' | 'startRef' | 'prepareArtifact'> = {
  slotId: 'macwork-mm-2',
  startRef: { requestedRef: '260bd3a5', resolvedSha: BASE },
  prepareArtifact: artifact,
};

test('a pinned run dispatches only with the build prepare installed on its slot for its start', () => {
  assert.equal(pinnedDispatchRefusal(prepared), undefined);
  assert.match(
    pinnedDispatchRefusal({ ...prepared, startRef: { requestedRef: '260bd3a5' } }) ?? '',
    /no resolved start commit/,
    'two missing values must not compare equal',
  );
  assert.match(
    pinnedDispatchRefusal({ ...prepared, prepareArtifact: null }) ?? '',
    /no record of the build/,
  );
  assert.match(
    pinnedDispatchRefusal({ ...prepared, prepareArtifact: { ...artifact, enforced: false } }) ?? '',
    /only an observed build/,
  );
  assert.match(
    pinnedDispatchRefusal({ ...prepared, slotId: 'macwork-mm-3' }) ?? '',
    /installed on macwork-mm-2, not on macwork-mm-3/,
  );
  assert.match(
    pinnedDispatchRefusal({
      ...prepared,
      prepareArtifact: { ...artifact, baseSha: 'b'.repeat(40) },
    }) ?? '',
    /is for b{40}, not the run's start/,
  );
});

// dev flow: find-slot 1, prepare 2, write-task 3, dispatch 4, monitor 5
const steps = { prepareIdx: 2, dispatchIdx: 4 };
const reroute = (
  targetIdx: number,
  extra: Partial<Parameters<typeof shouldReroutePinnedReplayToPrepare>[0]> = {},
) =>
  shouldReroutePinnedReplayToPrepare({
    pinned: true,
    liveNativeWorker: false,
    targetIdx,
    ...steps,
    ...extra,
  });

test('a pinned replay that would re-dispatch restarts from prepare', () => {
  assert.equal(reroute(4), true, 'a replay from dispatch prepares again');
  assert.equal(reroute(3), true, 'a replay from write-task too');
  assert.equal(reroute(5), false, 'a replay from monitor keeps the running worker');
  assert.equal(reroute(2), false, 'prepare itself needs no reroute');
  assert.equal(reroute(4, { pinned: false }), false);
  assert.equal(
    reroute(4, { liveNativeWorker: true }),
    false,
    'a live native worker is resumed, not launched over',
  );
});

function native(
  binding: Partial<NativeWorkerSessionBinding> | null,
  role: AgentContext['role'] = 'dev',
): Run {
  const context: AgentContext = {
    id: 'ctx',
    role,
    label: role,
    status: 'working',
    slotId: 'macwork-mm-2',
    runId: 'run',
    ...(binding
      ? {
          nativeSession: {
            sessionId: 's',
            executionNodeId: 'n',
            ownerPrincipalId: 'p',
            leaseId: 'l',
            commandId: 'c',
            ...binding,
          },
        }
      : {}),
  };
  // makeRun keeps neither transport nor contexts.
  return { ...makeRun({ flowType: 'dev' }), transport: 'native', agentContexts: [context] };
}

test('only a held, launched primary native worker counts as live', () => {
  const plain = { freshDispatch: false, workerRunnerOverride: false };
  const launched = { launchRequestedAt: '2026-11-25T10:00:00.000Z' };
  assert.equal(replayResumesNativeWorker(native(launched), plain), true);
  assert.equal(
    replayResumesNativeWorker(native({}), plain),
    false,
    'a reservation that never launched',
  );
  assert.equal(
    replayResumesNativeWorker(native({ ...launched, closedAt: '2026-11-25T10:05:00.000Z' }), plain),
    false,
    'a closed binding',
  );
  assert.equal(
    replayResumesNativeWorker(native(launched, 'review'), plain),
    false,
    'a held reviewer is not the primary worker',
  );
  assert.equal(
    replayResumesNativeWorker(native(launched), { ...plain, freshDispatch: true }),
    false,
  );
  assert.equal(
    replayResumesNativeWorker(native(launched), { ...plain, workerRunnerOverride: true }),
    false,
  );
  assert.equal(replayResumesNativeWorker({ ...native(launched), transport: 'tmux' }, plain), false);
  assert.equal(
    replayResumesNativeWorker({ ...native(launched), flowType: 'pr-complete' }, plain),
    false,
    'pr-complete looks up the primary context, so a dev context does not match',
  );
});

const provision = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  appInstalled: true,
  platform: 'ios',
  simulator: { name: 'mm-2', udid: 'UDID-2', created: false },
  artifact: { runId: '41900351233', revision: 'c'.repeat(40), branch: 'main' },
  recordedAt: '2026-11-25T09:00:00.000Z',
  ...fields,
});
const slot = { slotId: 'macwork-mm-2', baseSha: BASE, platform: 'ios', simulator: 'mm-2' };

test('an excluded trial records the Runway build its slot reports, unenforced', () => {
  assert.deepEqual(observedRunwayArtifact(provision(), slot), {
    kind: 'runway',
    slotId: 'macwork-mm-2',
    baseSha: BASE,
    runId: '41900351233',
    revision: 'c'.repeat(40),
    platform: 'ios',
    installedAt: '2026-11-25T09:00:00.000Z',
    enforced: false,
  });
  assert.equal(
    observedRunwayArtifact(provision(), { ...slot, simulator: 'UDID-2' })?.runId,
    '41900351233',
    'the simulator matches by udid too',
  );
  assert.equal(
    observedRunwayArtifact(
      provision({ artifact: { runId: '41900351233', revision: '41900351233' } }),
      slot,
    )?.revision,
    undefined,
    'an unverified record keeps the run id when the revision is not a commit',
  );
});

test('an observed record is written only when the file vouches for this slot', () => {
  assert.equal(
    observedRunwayArtifact(provision({ appInstalled: false }), slot),
    undefined,
    'a source build marks the Runway app as not installed',
  );
  assert.equal(observedRunwayArtifact(provision(), { ...slot, simulator: 'mm-3' }), undefined);
  assert.equal(observedRunwayArtifact(provision(), { ...slot, simulator: undefined }), undefined);
  assert.equal(observedRunwayArtifact(provision({ artifact: null }), slot), undefined);
  assert.equal(observedRunwayArtifact(provision({ recordedAt: undefined }), slot), undefined);
});

test('only excluded eval trials on a taking-part project observe their build', () => {
  const proof = { ...comparison, flowType: 'qa' as const };
  assert.equal(prepareObservesBuild(proof, mobile), true, 'a proof trial');
  assert.equal(prepareObservesBuild(comparison, mobile), false, 'a pinned run enforces instead');
  assert.equal(prepareObservesBuild(proof, extension), false);
  assert.equal(
    prepareObservesBuild(proof, undefined),
    false,
    'unreadable config: best effort, nothing',
  );
  assert.equal(prepareObservesBuild({ ...proof, startRef: null }, mobile), false);
  assert.equal(prepareObservesBuild({ ...proof, lane: 'production' }, mobile), false);
});

test('the provision record is read from the checkout first, then from the capsule', () => {
  assert.deepEqual(observedBuildFiles('/slot', 'temp/runtime', '/capsules/trial-1'), [
    '/slot/temp/runtime/runway-provision.json',
    '/capsules/trial-1/original-ignored/temp/runtime/runway-provision.json',
  ]);
  assert.deepEqual(observedBuildFiles('/slot', 'temp/runtime', undefined), [
    '/slot/temp/runtime/runway-provision.json',
  ]);
});
