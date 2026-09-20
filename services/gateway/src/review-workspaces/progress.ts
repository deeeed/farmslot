// Live progress for a slot-free static review workspace (ADR-058): the same
// TASK_PROGRESS_UPDATED clients already receive for a slot worker, plus the view
// refresh that keeps the operator-visible mirror current.
//
// A workspace run has no slot, so the slot task watcher — keyed by slot id,
// reading slot vars and fleet state — cannot observe it. What it does have is the
// monitor step, which already reads the execution node once a second for the
// worker's own session state; this rides that loop instead of adding a second
// watch subsystem for the same directory. The reads are the projection's own, so
// a child unit (ADR-060) and the acceptance ledger reach clients here exactly as
// `task.progress` reports them.

import { Events, type TaskProgressResult, type TaskStepProgress } from '@farmslot/protocol';

import { taskProgress } from '../methods/task.js';

import { refreshReviewWorkspaceView } from './task.js';

type EmitFn = (event: string, payload: unknown) => void;

/** The parent checklist every review workspace task directory enumerates. */
const PARENT_CHECKLIST = 'CHECKLIST.md';

/**
 * Minimum gap between two progress reads for one run. The monitor polls its
 * worker every second for session state, which is cheap and local to the node;
 * a progress read walks the checklist, the child registry, every child signal
 * and the ledger, so it runs at half that rate.
 */
export const WORKSPACE_PROGRESS_INTERVAL_MS = 2000;

/** Checkbox states of the parent checklist, as the watcher's own hash does it. */
function parentSignature(markdown: string): string {
  let hash = '';
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]')) hash += '1';
    else if (trimmed.startsWith('- [ ]')) hash += '0';
  }
  return hash;
}

function structuredSteps(progress: TaskProgressResult): TaskStepProgress[] {
  return (progress.structured?.phases ?? []).flatMap((phase) => phase.steps);
}

/**
 * Everything about the child units that a client would render: which children
 * exist, their status, their own step counts and their last mark. A child mark
 * ticks no parent box, so without this the parent hash would swallow every
 * child update.
 */
function childSignature(progress: TaskProgressResult): string {
  return structuredSteps(progress)
    .flatMap((step) =>
      step.subtask
        ? [
            `${step.index}:${step.subtask.id}:${step.subtask.status}:` +
              `${step.subtask.progress.completedSteps}/${step.subtask.progress.totalSteps}:` +
              `${step.subtask.lastEventAt ?? ''}`,
          ]
        : [],
    )
    .join('|');
}

/** Recorded verdicts and the read error, which a client shows in place of them. */
function ledgerSignature(progress: TaskProgressResult): string {
  const verdicts = (progress.acceptanceStatus?.criteria ?? [])
    .map((entry) => `${entry.id}:${entry.verdict}:${entry.updatedAt}`)
    .join(',');
  return `${verdicts}#${progress.acceptanceStatusError ?? ''}`;
}

/**
 * The two reads this publisher performs, injected so its own rules — throttle,
 * change detection, the child tag — are tested without a workspace on disk. The
 * production defaults are the same projection clients call and the same view
 * refresh completion uses.
 */
export interface ReviewWorkspaceProgressDeps {
  readProgress: (runId: string) => Promise<TaskProgressResult>;
  refreshView: (runId: string) => Promise<number>;
}

const progressDefaults: ReviewWorkspaceProgressDeps = {
  readProgress: (runId) => taskProgress({ slotId: '', runId }),
  refreshView: (runId) => refreshReviewWorkspaceView(runId),
};

export interface ReviewWorkspaceProgressPublisher {
  /**
   * Read the projection once and, when it moved, refresh the view and broadcast.
   * Returns the progress it published, or null when nothing changed or the read
   * failed.
   */
  publish(): Promise<TaskProgressResult | null>;
}

/**
 * Follow one review workspace run's task directory for as long as its monitor
 * step owns it.
 *
 * `isCurrent` is the monitor's own generation check: a publisher whose run has
 * been superseded stops emitting rather than broadcasting progress for a worker
 * another generation replaced. The publisher holds no watcher and no timer, so
 * the monitor loop exiting is the whole teardown.
 */
export function createReviewWorkspaceProgressPublisher(
  runId: string,
  emit: EmitFn,
  options: { isCurrent?: () => boolean; now?: () => number } = {},
  deps: ReviewWorkspaceProgressDeps = progressDefaults,
): ReviewWorkspaceProgressPublisher {
  const now = options.now ?? (() => Date.now());
  let lastReadAt = Number.NEGATIVE_INFINITY;
  let lastParent: string | null = null;
  let lastChildren: string | null = null;
  let lastLedger: string | null = null;

  return {
    async publish(): Promise<TaskProgressResult | null> {
      if (options.isCurrent?.() === false) return null;
      if (now() - lastReadAt < WORKSPACE_PROGRESS_INTERVAL_MS) return null;
      lastReadAt = now();

      let progress: TaskProgressResult;
      try {
        progress = await deps.readProgress(runId);
      } catch (err) {
        // The monitor step owns the run's outcome; a progress read is
        // observability beside it and must not decide the run failed. Reported at
        // error level, not warn, because the alternative reading — a corrupt child
        // registry or an unreadable checklist — means clients are now showing
        // progress that has stopped advancing, and nothing else in the log would
        // say so. A real workspace fault still ends the run through the monitor's
        // own completion read.
        console.error(
          `[review-workspace] progress read failed for ${runId.slice(0, 8)}: ${(err as Error).message}`,
        );
        return null;
      }
      if (options.isCurrent?.() === false) return null;

      const parent = parentSignature(progress.markdown);
      const children = childSignature(progress);
      const ledger = ledgerSignature(progress);
      if (parent === lastParent && children === lastChildren && ledger === lastLedger) return null;
      // A child drove this update when its own state moved and no parent box did:
      // the acceptance rule needs the parent checklist to tell a live child from
      // one whose parent checklist is no longer the active one.
      const fromChild = children !== lastChildren && parent === lastParent;
      const firstRead = lastParent === null;
      lastParent = parent;
      lastChildren = children;
      lastLedger = ledger;

      try {
        await deps.refreshView(runId);
      } catch (err) {
        // Same reason as above: the mirror is the operator's copy, not the run's
        // verdict. Completion snapshots the whole task directory into the view
        // again, so a failure here costs visibility until then, never proof.
        console.error(
          `[review-workspace] view refresh failed for ${runId.slice(0, 8)}: ${(err as Error).message}`,
        );
      }
      if (options.isCurrent?.() === false) return null;

      emit(Events.TASK_PROGRESS_UPDATED, {
        slotId: '',
        runId,
        role: 'review',
        contextId: 'review',
        progress,
        ...(fromChild && !firstRead ? { parentChecklist: PARENT_CHECKLIST } : {}),
      });
      return progress;
    },
  };
}
