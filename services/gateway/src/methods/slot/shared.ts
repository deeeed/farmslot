import type { PrepareStepRecord } from '@farmslot/protocol';

import {
  type ProjectVars,
  type RawProjectJson,
  readSlotField,
  type SlotVars,
} from '../../core/index.js';
import type { StartRefResolution } from '../../projects/start-ref-resolution.js';

import type { PrepareProfileFallback } from './prepare-profile.js';

export type EventEmitter = (event: string, payload: unknown) => void;
export type SlotPrepareResult = {
  prepared: boolean;
  requestId: string;
  startRef?: StartRefResolution;
  /** Upstream PR head a stacked run's branch was created from. */
  stackBase?: StartRefResolution;
  /** Selected prepare profile + any precondition fallbacks taken (ADR-037). */
  profile?: { selected: string; requested?: string; fallbacks: PrepareProfileFallback[] };
};
export interface SlotPrepareInternalOptions {
  /** The keep-warm re-prepare a release runs while it still holds the releasing fence. */
  duringRelease?: boolean;
  stripClean?: boolean;
  /** Reuse existing run work. Clean review/QA retries may preserve old tips and
   * reset to the current published or frozen head; dirty trees remain untouched. */
  preserveBranch?: boolean;
  /** Only with durable evidence that this run has not started branch setup. */
  allowMissingReplayBranch?: boolean;
  beforeBranchSetup?: () => Promise<void>;
  startRef?: { requestedRef: string };
  /** Stacked run: create a new work branch from this pushed ref instead of the default branch. */
  stackBase?: { requestedRef: string };
  /** Called as soon as the stack base resolves, before any later prepare phase can fail. */
  onStackBaseResolved?: (resolution: StartRefResolution) => Promise<void>;
}

export interface PrepareCommandError extends Error {
  failedCommand?: string;
  failedLogPath?: string;
  failedPhase?: string;
  relatedLogs?: string[];
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
export const activePrepareAborts = new Map<string, { abort: () => void; settled: Promise<void> }>();

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
