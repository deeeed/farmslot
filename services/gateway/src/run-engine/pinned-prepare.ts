import {
  isEvalRun,
  nativeWorkerBindingIsHeld,
  type Run,
  workerRoleForFlow,
} from '@farmslot/protocol';

import { loadProjectVars, type RawProjectJson } from '../core/index.js';
import { usesEvalTrialCapsule } from '../evals/trial-policy.js';
import { projectPinsPrepare } from '../methods/slot/pinned-prepare.js';

type PinnedRunFields = Pick<Run, 'lane' | 'startRef' | 'flowType' | 'engineState'>;

/**
 * A run whose prepare must install a build of its start commit: a comparison-lane
 * dev or fix-bug run with a start ref (start-ref-policy.ts limits a user start ref
 * to these flows). Blind capsule trials keep their own isolated base, and QA proof
 * trials run no app build, so neither is pinned.
 */
export function isPinnedPrepareRun(run: PinnedRunFields): boolean {
  return (
    isEvalRun(run) &&
    Boolean(run.startRef) &&
    (run.flowType === 'dev' || run.flowType === 'fix-bug') &&
    !usesEvalTrialCapsule(run.engineState?.evalExperiment?.blind)
  );
}

/**
 * Whether this run's prepare is pinned: the run qualifies and its project takes
 * part. An unreadable project config counts as taking part, so the prepare refuses
 * instead of running on whatever build the slot has.
 */
export function prepareIsPinned(
  run: PinnedRunFields,
  projectJson: RawProjectJson | undefined,
): boolean {
  return isPinnedPrepareRun(run) && (projectJson ? projectPinsPrepare(projectJson) : true);
}

export async function runPrepareIsPinned(
  run: PinnedRunFields & Pick<Run, 'project'>,
): Promise<boolean> {
  if (!isPinnedPrepareRun(run)) return false;
  let projectJson: RawProjectJson | undefined;
  try {
    projectJson = (await loadProjectVars(run.project)).projectJson;
  } catch {
    projectJson = undefined;
  }
  return prepareIsPinned(run, projectJson);
}

/**
 * Why a pinned run may not dispatch, or undefined when its record shows the build
 * prepare installed on this slot for this start. Prepare refuses a mismatch itself;
 * this covers the paths that reach dispatch without that prepare running.
 */
export function pinnedDispatchRefusal(
  run: Pick<Run, 'slotId' | 'startRef' | 'prepareArtifact'>,
): string | undefined {
  const base = run.startRef?.resolvedSha;
  if (!base) return 'A pinned comparison run has no resolved start commit; prepare it first';
  const artifact = run.prepareArtifact;
  if (!artifact)
    return 'A pinned comparison run has no record of the build prepare installed; prepare it first';
  if (!artifact.enforced)
    return 'A pinned comparison run carries only an observed build, not one prepare installed; prepare it first';
  if (artifact.slotId !== run.slotId)
    return `The build was installed on ${artifact.slotId}, not on ${run.slotId ?? 'this run’s slot'}; prepare again`;
  if (artifact.baseSha !== base)
    return `The installed build is for ${artifact.baseSha}, not the run's start ${base}; prepare again`;
  return undefined;
}

/**
 * A replay of a pinned run restarts from prepare when its target lies after prepare
 * and at or before dispatch, so a slot whose app changed since (a bulk Runway update)
 * gets the pinned build again. Later targets keep the running worker; so does a live
 * native worker, which a second prepare and dispatch would launch over.
 */
export function shouldReroutePinnedReplayToPrepare(input: {
  pinned: boolean;
  adoptedLiveWorker: boolean;
  liveNativeWorker: boolean;
  targetIdx: number;
  prepareIdx: number;
  dispatchIdx: number;
}): boolean {
  if (!input.pinned || input.adoptedLiveWorker || input.liveNativeWorker) return false;
  return (
    input.prepareIdx >= 0 &&
    input.dispatchIdx >= 0 &&
    input.targetIdx > input.prepareIdx &&
    input.targetIdx <= input.dispatchIdx
  );
}

/**
 * A native worker this replay would resume rather than replace: the primary role's
 * binding is held and its launch was requested, and the replay asks for neither a
 * fresh dispatch nor another runner.
 */
export function replayResumesNativeWorker(
  run: Pick<Run, 'transport' | 'flowType' | 'agentContexts'>,
  replay: { freshDispatch?: boolean; runnerOverride: boolean },
): boolean {
  if (run.transport !== 'native' || replay.freshDispatch || replay.runnerOverride) return false;
  const role = workerRoleForFlow(run.flowType);
  const primary = role ? run.agentContexts?.find((context) => context.role === role) : undefined;
  return Boolean(
    primary?.nativeSession &&
    nativeWorkerBindingIsHeld(primary.nativeSession) &&
    primary.nativeSession.launchRequestedAt,
  );
}
