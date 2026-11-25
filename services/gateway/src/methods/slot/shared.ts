import type { PrepareStepRecord } from '@farmslot/protocol';

import {
  type ProjectVars,
  type RawProjectJson,
  readSlotField,
  type SlotVars,
} from '../../core/index.js';
import type { StartRefResolution } from '../../projects/start-ref-resolution.js';

import type { PinnedPrepareArtifact } from './pinned-prepare.js';
import type { PrepareProfileFallback } from './prepare-profile.js';

/** Names the supported exit from a held slot whose workspace recovery failed. */
export const RECOVER_HINT =
  "Resume this slot's recovery with `farmslot slot refresh <slot> --recover`.";

export type EventEmitter = (event: string, payload: unknown) => void;
export type SlotPrepareResult = {
  prepared: boolean;
  requestId: string;
  startRef?: StartRefResolution;
  /** Upstream PR head a stacked run's branch was created from. */
  stackBase?: StartRefResolution;
  /** Selected prepare profile + any precondition fallbacks taken (ADR-037). */
  profile?: { selected: string; requested?: string; fallbacks: PrepareProfileFallback[] };
  /** Lockfiles the deps phase rewrote for a drifted PR branch; the worker must commit them. */
  lockfilesRewritten?: string[];
  /** Branches prepare created to keep unpushed commits of a branch it deleted or reset. */
  keptBranches?: string[];
  /** The build a pinned prepare installed, from its preflight's receipt. */
  prepareArtifact?: PinnedPrepareArtifact & { installedAt: string };
};
export interface SlotPrepareInternalOptions {
  /** The keep-warm re-prepare a release runs while it still holds the releasing fence. */
  duringRelease?: boolean;
  /** Engine prepare: refuse unless `params.runId` still holds the slot and is not terminal. */
  requireRunOwnership?: boolean;
  stripClean?: boolean;
  /** Reuse the run's existing work branch without resetting or cleaning it. */
  preserveBranch?: boolean;
  /** Trusted base after the owning eval has isolated the Git object store. */
  blindBaseSha?: string;
  /** Original repository identity retained in the gateway before blind isolation. */
  blindRepoKey?: string;
  /** Only with durable evidence that this run has not started branch setup. */
  allowMissingReplayBranch?: boolean;
  beforeBranchSetup?: () => Promise<void>;
  startRef?: { requestedRef: string };
  /**
   * A pinned comparison run (`isPinnedPrepareRun`). When the project takes part
   * (`projectPinsPrepare`), prepare selects only from `prepare.pinned_profiles`,
   * strictly, hands the resolved start commit to preflight and requires its
   * receipt; a project config that fails to load refuses the prepare.
   */
  pinned?: boolean;
  /** Stacked run: create a new work branch from this pushed ref instead of the default branch. */
  stackBase?: { requestedRef: string };
  /** Called as soon as the stack base resolves, before any later prepare phase can fail. */
  onStackBaseResolved?: (resolution: StartRefResolution) => Promise<void>;
  /** Called as soon as prepare keeps a branch's unpushed commits, before any later phase can fail. */
  onBranchKept?: (branch: string) => void;
}

export interface PrepareCommandError extends Error {
  failedCommand?: string;
  failedLogPath?: string;
  failedPhase?: string;
  /** A failure the run can act on: the install refused a lockfile that does not match package.json. */
  failureKind?: 'lockfile-drift';
  /** Slot-host paths: the slot's runtime logs. */
  relatedLogs?: string[];
  /** The slot is local, so its related logs are files the gateway can read. */
  relatedLogsOnGateway?: boolean;
  /** Set when the harness readiness record could not be persisted after a failed preflight; the preflight error stays primary. */
  readinessError?: unknown;
}

export interface CheckStep {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail: string;
}

export { activePrepareSlots } from '../../core/native-worker-exclusion.js';

/** In-flight prepare session per slot, so a reloaded UI can re-attach to the
 * live `slot.prepare.*` stream and recover the steps it missed (ADR-037).
 * Populated by createPrepareStream for the stream's lifetime. */
export interface ActivePrepareSession {
  requestId: string;
  startedAt: number;
  steps: PrepareStepRecord[];
}
export const activePrepareSessions = new Map<string, ActivePrepareSession>();

/** In-flight prepare per slot, so a release can stop it and wait for it to
 * settle before reaping its scope: otherwise the prepare launches its
 * preflight holder after the release found nothing to reap. */
/** In-flight prepares by slot; runId names the run a prepare is for, when it is for one. */
export const activePrepareAborts = new Map<
  string,
  { abort: () => void; settled: Promise<void>; runId?: string }
>();

export const DEFAULT_GATEWAY_PORT = 7777;

function normalizeSelectedApp(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function applySelectedApp(slotVars: SlotVars, appOverride?: string): Promise<string> {
  const explicitApp = normalizeSelectedApp(appOverride);
  const persistedApp = explicitApp
    ? ''
    : normalizeSelectedApp(await readSlotField(slotVars.slotId, 'app'));
  const selectedApp =
    explicitApp || persistedApp || normalizeSelectedApp(slotVars.resourceVars.app);
  if (selectedApp) {
    slotVars.resourceVars.app = selectedApp;
  } else {
    delete slotVars.resourceVars.app;
  }
  return selectedApp;
}

export function sanitizePhaseName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'phase'
  );
}

export type { ProjectVars, RawProjectJson, SlotVars };
