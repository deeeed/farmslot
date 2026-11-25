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

import {
  isPinnedPrepareRun,
  pinnedDispatchRefusal,
  prepareIsPinned,
  replayResumesNativeWorker,
  shouldReroutePinnedReplayToPrepare,
} from './pinned-prepare.js';

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
    adoptedLiveWorker: false,
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
  assert.equal(reroute(4, { adoptedLiveWorker: true }), false, 'an adopted live worker wins');
  assert.equal(
    reroute(4, { liveNativeWorker: true }),
    false,
    'a live native worker is resumed, not launched over',
  );
});

function native(
  binding: Partial<NativeWorkerSessionBinding> | null,
  role: AgentContext['role'] = 'dev',
): Pick<Run, 'transport' | 'flowType' | 'agentContexts'> {
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
  return { transport: 'native', flowType: 'dev', agentContexts: [context] };
}

test('only a held, launched primary native worker counts as live', () => {
  const plain = { freshDispatch: false, runnerOverride: false };
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
    replayResumesNativeWorker(native(launched), { ...plain, runnerOverride: true }),
    false,
  );
  assert.equal(replayResumesNativeWorker({ ...native(launched), transport: 'tmux' }, plain), false);
  assert.equal(
    replayResumesNativeWorker({ ...native(launched), flowType: 'pr-complete' }, plain),
    false,
    'a flow with no worker role has no primary worker',
  );
});
