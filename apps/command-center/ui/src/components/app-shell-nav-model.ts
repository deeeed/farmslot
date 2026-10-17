import type { Run, RunStep, SlotStatus } from '@farmslot/protocol';
import { taskTitleText } from '@farmslot/protocol';

import type { GlobalFilters } from '../state.js';

import { activeRunsForGlobalFilters } from './runs/run-list-model.js';

export const SIDEBAR_WIDTH_PREF_KEY = 'farmslot:sidebar-expanded-width';
export const DEFAULT_SIDEBAR_WIDTH = 260;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 420;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(width)));
}

export function parseStoredSidebarWidth(value: string | null): number {
  if (!value) return DEFAULT_SIDEBAR_WIDTH;
  return clampSidebarWidth(Number(value));
}

export function activeSidebarRuns(
  runs: readonly Run[],
  globalFilters: GlobalFilters,
  slots: readonly Pick<SlotStatus, 'slot' | 'machine'>[],
  limit = 8,
): Run[] {
  return activeRunsForGlobalFilters(runs, globalFilters, slots).slice(0, limit);
}

export function sidebarRunRoute(run: Pick<Run, 'id' | 'slotId' | 'status'>): string {
  return run.slotId && run.status !== 'failed' ? `#slot/${run.slotId}` : `#run/${run.id}`;
}

export function sidebarRunSummary(
  run: Pick<Run, 'summary' | 'branch' | 'ticketOrPr' | 'steps'>,
): string {
  const running = run.steps.find((step) => step.status === 'running');
  return (
    (run.summary ? taskTitleText(run.summary) : '') ||
    running?.detail?.trim() ||
    (running ? `Running ${running.name}` : '') ||
    run.branch?.trim() ||
    run.ticketOrPr
  );
}

export function sidebarPreviewSteps(steps: readonly RunStep[], limit = 5): RunStep[] {
  if (steps.length <= limit) return [...steps];
  const runningIndex = steps.findIndex((step) => step.status === 'running');
  if (runningIndex < 0) return steps.slice(0, limit);
  const start = Math.max(0, Math.min(runningIndex - 1, steps.length - limit));
  return steps.slice(start, start + limit);
}
