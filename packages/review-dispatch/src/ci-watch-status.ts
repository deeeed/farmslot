import { isTerminalRunStatus, type Run } from '@farmslot/protocol';

export interface CIWatchStatusView {
  label: string;
  description: string;
  live: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function remaining(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(Math.max(0, ms) / 1000)}s`;
  const minutes = Math.ceil(Math.max(0, ms) / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/** A worker fix is active only when both recorded phase and explicit flag agree. */
export function isCIWatchWorkerFixActive(phase: unknown, fixInProgress: unknown): boolean {
  return fixInProgress === true && (phase === 'fixing' || phase === 'waiting_for_worker');
}

/** The same recorded check snapshot and engine deadlines on web and native run cards. */
export function ciWatchStatusView(
  run: Run | null | undefined,
  nowMs = Date.now(),
): CIWatchStatusView | null {
  if (!run || isTerminalRunStatus(run.status)) return null;
  const step = run.steps.find((entry) => entry.name === 'ci-watch');
  if (!step || (step.status !== 'running' && run.status !== 'ci-watching')) return null;
  const out = step.outputs ?? {};
  const summary = isRecord(out.checkSummary) ? out.checkSummary : undefined;
  const passed = count(summary?.passed);
  const total = count(summary?.total);
  const failed = count(summary?.failed);
  const pending = count(summary?.pending);
  const names = out.failedNames ?? out.failedChecks;
  const failedNames = Array.isArray(names)
    ? names.filter((name): name is string => typeof name === 'string' && !!name.trim())
    : [];
  const parts = [passed !== undefined && total ? `CI ${passed}/${total}` : 'CI checking'];
  if (failed)
    parts.push(`${failed} failed${failedNames.length ? `: ${failedNames.join(', ')}` : ''}`);
  if (pending) parts.push(`${pending} pending`);
  const comments = count(out.actionableBotCommentCount);
  if (comments) parts.push(`${comments} actionable comment${comments === 1 ? '' : 's'}`);
  const phase = out.phase;
  if (
    run.status === 'paused' ||
    phase === 'decision_required' ||
    phase === 'blocked' ||
    phase === 'done'
  ) {
    parts.push(
      run.status === 'paused' ? 'paused' : phase === 'done' ? 'finishing' : 'waiting for input',
    );
    return { label: parts.join(' · '), description: parts.join(' · '), live: false };
  }
  const fixing = isCIWatchWorkerFixActive(phase, out.fixInProgress);
  const pollAt = timestamp(out.nextPollAt);
  parts.push(
    fixing
      ? 'worker fixing'
      : pollAt === undefined
        ? 'checking now'
        : pollAt <= nowMs
          ? 'next check now'
          : `next check ${remaining(pollAt - nowMs)}`,
  );
  const progressAt = timestamp(out.progressTimeoutAt);
  const totalAt = timestamp(out.totalTimeoutAt);
  let description = '';
  if (progressAt !== undefined && totalAt !== undefined) {
    const timeoutAt = Math.min(progressAt, totalAt);
    parts.push(timeoutAt <= nowMs ? 'timeout due' : `times out in ${remaining(timeoutAt - nowMs)}`);
    description = `No-progress timeout ${progressAt <= nowMs ? 'due' : `in ${remaining(progressAt - nowMs)}`}; total timeout ${totalAt <= nowMs ? 'due' : `in ${remaining(totalAt - nowMs)}`}`;
  } else {
    parts.push('timeout unavailable');
  }
  return {
    label: parts.join(' · '),
    description: `${parts.join(' · ')}${description ? `. ${description}` : ''}`,
    live: true,
  };
}
