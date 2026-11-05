import type { Run, RunStep, SlotStatus, TmuxWorkerListResult } from '@farmslot/protocol';
import { taskTitleText } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

import type { GlobalFilters } from '../state.js';
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH } from '../utils/sidebar-view-state.js';
import { buildHash, parseHashRoute } from '../utils/url-state.js';

export {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_PANEL_FIELD,
} from '../utils/sidebar-view-state.js';

import { activeRunsForGlobalFilters } from './runs/run-list-model.js';

export const SIDEBAR_WIDTH_PREF_KEY = 'farmslot:sidebar-expanded-width';

/** Carry only shell choices across routes; a destination's explicit choices win. */
export function sidebarNavigationHash(destination: string, current = location.hash): string {
  const { route, params } = parseHashRoute(destination);
  return buildHash(route, params, current);
}

export function pinnedWorkerReadError(state: ResourceQueryState<TmuxWorkerListResult>): string {
  if (state.error) {
    if (['RESOURCE_SOURCE_UNAVAILABLE', 'RESOURCE_SOURCE_CHANGED'].includes(state.error.code))
      return '';
    return state.error.message;
  }
  return (
    state.data?.nodes
      .filter((node) => node.connected && !node.ok)
      .map((node) => `${node.nodeId}: ${node.error ?? 'worker inventory unavailable'}`)
      .join('; ') ?? ''
  );
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
