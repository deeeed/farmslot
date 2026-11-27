import {
  isEvalRun,
  isRecord,
  nativeWorkerBindingIsHeld,
  primaryRoleForFlow,
  type Run,
  type RunPrepareArtifact,
} from '@farmslot/protocol';

import { selectAgentContext } from '../agents/contexts.js';
import type { RawProjectJson } from '../core/index.js';
import { FULL_COMMIT } from '../evals/blind-inputs.js';
import { resolvePinnedProfile } from '../methods/slot/pinned-prepare.js';
import {
  isPinnedPrepareRun,
  type PinnedRunFields,
  prepareIsPinned,
  projectPinsPrepare,
} from '../projects/pinned-prepare-policy.js';

import { loadProjectVarsOrNull } from './project-vars.js';

export async function runPrepareIsPinned(
  run: PinnedRunFields & Pick<Run, 'project' | 'id'>,
): Promise<boolean> {
  if (!isPinnedPrepareRun(run)) return false;
  const projectVars = await loadProjectVarsOrNull(run.project, 'pinned prepare', run.id);
  return prepareIsPinned(run, projectVars?.projectJson);
}

/**
 * The profile a pinned run activated on a slot prepares with: the one it stored,
 * when that is listed for the slot's platform (a run sent to `full` because no
 * Runway build matches stays there), otherwise the platform's pinned default.
 * Refuses when the project config is unreadable or names no profile for it.
 */
export async function pinnedActivationProfile(
  run: Pick<Run, 'project' | 'id' | 'prepareProfile'>,
  platform: string,
): Promise<string> {
  const projectVars = await loadProjectVarsOrNull(run.project, 'pinned activation', run.id);
  if (!projectVars)
    throw new Error(
      `A pinned comparison run cannot be activated: the config of project ${run.project} failed to load`,
    );
  const { projectJson } = projectVars;
  if (run.prepareProfile) {
    try {
      return resolvePinnedProfile(projectJson, platform, run.prepareProfile).name;
    } catch {
      // Not listed for this platform: the default below.
    }
  }
  return resolvePinnedProfile(projectJson, platform).name;
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
 * Refuse to dispatch a pinned run without its build. `projectJson` is undefined
 * when the config could not be read, which counts as pinned.
 */
export function assertPinnedRunDispatchable(
  run: Run,
  projectJson: RawProjectJson | undefined,
): void {
  if (!prepareIsPinned(run, projectJson)) return;
  const refusal = pinnedDispatchRefusal(run);
  if (refusal) throw new Error(refusal);
}

/**
 * A replay of a pinned run restarts from prepare when its target lies after prepare
 * and at or before dispatch, so a slot whose app changed since (a bulk Runway update)
 * gets the pinned build again. Later targets keep the running worker (an adopted task
 * signal already moves the replay to monitor); so does a live native worker, which a
 * second prepare and dispatch would launch over.
 */
export function shouldReroutePinnedReplayToPrepare(input: {
  pinned: boolean;
  liveNativeWorker: boolean;
  targetIdx: number;
  prepareIdx: number;
  dispatchIdx: number;
}): boolean {
  if (!input.pinned || input.liveNativeWorker) return false;
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
 * fresh dispatch nor another worker runner.
 */
export function replayResumesNativeWorker(
  run: Run,
  replay: { freshDispatch?: boolean; workerRunnerOverride: boolean },
): boolean {
  if (run.transport !== 'native' || replay.freshDispatch || replay.workerRunnerOverride)
    return false;
  // Only pinned runs ask, and their dev/fix-bug flows always have a worker role.
  const primary = selectAgentContext(run, { role: primaryRoleForFlow(run.flowType) });
  return Boolean(
    primary?.nativeSession &&
    nativeWorkerBindingIsHeld(primary.nativeSession) &&
    primary.nativeSession.launchRequestedAt,
  );
}

/** The harness record of the Runway build it installed on a slot. */
export const RUNWAY_PROVISION_RECORD = 'runway-provision.json';

/**
 * Where a slot's provision record may be, in the order to read it: the checkout,
 * which an explicit runway prepare after isolation rewrites, then the capsule copy
 * isolation moved every ignored file into (also where a capsule retry finds it).
 */
export function observedBuildFiles(
  remoteRepo: string,
  runtimeDir: string,
  capsulePath: string | undefined,
): string[] {
  return [
    `${remoteRepo}/${runtimeDir}/${RUNWAY_PROVISION_RECORD}`,
    ...(capsulePath
      ? [`${capsulePath}/original-ignored/${runtimeDir}/${RUNWAY_PROVISION_RECORD}`]
      : []),
  ];
}

/** An eval run with a start ref that pinning excludes: capsule and proof trials. */
export function isObservedBuildRun(run: PinnedRunFields): boolean {
  return isEvalRun(run) && Boolean(run.startRef) && !isPinnedPrepareRun(run);
}

/**
 * Whether prepare records the build it found for this run without enforcing it: an
 * excluded eval run on a project that takes part. Analysis filters those cells by
 * this record.
 */
export function prepareObservesBuild(
  run: PinnedRunFields,
  projectJson: RawProjectJson | undefined,
): boolean {
  return isObservedBuildRun(run) && Boolean(projectJson && projectPinsPrepare(projectJson));
}

/**
 * The observed record from a slot's `runway-provision.json`, or undefined when it
 * cannot vouch for the app on this slot: not installed (a source build sets
 * `appInstalled: false`), another simulator, or no Runway run id.
 */
export function observedRunwayArtifact(
  record: Record<string, unknown>,
  slot: { slotId: string; baseSha: string; platform: string; simulator?: string },
): RunPrepareArtifact | undefined {
  if (record.appInstalled !== true || typeof record.recordedAt !== 'string') return undefined;
  const simulator = isRecord(record.simulator) ? record.simulator : undefined;
  if (!slot.simulator || (simulator?.name !== slot.simulator && simulator?.udid !== slot.simulator))
    return undefined;
  const artifact = isRecord(record.artifact) ? record.artifact : undefined;
  if (typeof artifact?.runId !== 'string' || !artifact.runId) return undefined;
  const revision =
    typeof artifact.revision === 'string' && FULL_COMMIT.test(artifact.revision)
      ? artifact.revision
      : undefined;
  return {
    kind: 'runway',
    slotId: slot.slotId,
    baseSha: slot.baseSha,
    runId: artifact.runId,
    ...(revision ? { revision } : {}),
    platform: slot.platform,
    installedAt: record.recordedAt,
    enforced: false,
  };
}
