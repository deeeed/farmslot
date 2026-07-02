import type { Run, RunStatus, RunStep } from '@farmslot/protocol';

export const SIDEBAR_WIDTH_PREF_KEY = 'farmslot:sidebar-expanded-width';
export const DEFAULT_SIDEBAR_WIDTH = 260;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 420;

const SIDEBAR_ACTIVE_STATUSES = new Set<RunStatus>([
  'created',
  'grading',
  'writing-task',
  'slot-finding',
  'preparing',
  'dispatching',
  'monitoring',
  'self-reviewing',
  'completing',
  'ci-watching',
  'human-gating',
  'blocked',
  'paused',
  'failed',
]);

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(width)));
}

export function parseStoredSidebarWidth(value: string | null): number {
  if (!value) return DEFAULT_SIDEBAR_WIDTH;
  return clampSidebarWidth(Number(value));
}

export function isSidebarActiveRun(run: Pick<Run, 'status'>): boolean {
  return SIDEBAR_ACTIVE_STATUSES.has(run.status);
}

export function activeSidebarRuns(runs: readonly Run[], limit = 8): Run[] {
  return runs.filter(isSidebarActiveRun).slice(0, limit);
}

export function sidebarRunRoute(run: Pick<Run, 'id' | 'slotId' | 'status'>): string {
  return run.slotId && run.status !== 'failed' ? `#slot/${run.slotId}` : `#run/${run.id}`;
}

export function sidebarRunSummary(
  run: Pick<Run, 'summary' | 'branch' | 'ticketOrPr' | 'steps'>,
): string {
  const running = run.steps.find((step) => step.status === 'running');
  return (
    run.summary?.trim() ||
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
