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
  /** Selected prepare profile + any precondition fallbacks taken (ADR-037). */
  profile?: { selected: string; requested?: string; fallbacks: PrepareProfileFallback[] };
};
export interface SlotPrepareInternalOptions {
  stripClean?: boolean;
  startRef?: { requestedRef: string };
}

export interface PrepareCommandError extends Error {
  failedCommand?: string;
  failedLogPath?: string;
  failedPhase?: string;
  relatedLogs?: string[];
}

export interface CheckStep {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail: string;
}

export const activePrepareSlots = new Set<string>();

/** In-flight prepare session per slot, so a reloaded UI can re-attach to the
 * live `slot.prepare.*` stream and recover the steps it missed (ADR-037).
 * Populated by createPrepareStream for the stream's lifetime. */
export interface ActivePrepareSession {
  requestId: string;
  startedAt: number;
  steps: Array<{ name: string; detail: string }>;
}
export const activePrepareSessions = new Map<string, ActivePrepareSession>();

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
