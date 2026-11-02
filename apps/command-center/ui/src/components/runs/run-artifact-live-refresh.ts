import {
  awaitsHumanDecision,
  isHeldForResultDecision,
  isTerminalRunStatus,
  type Run,
  type RunRefreshMirrorResult,
} from '@farmslot/protocol';
import { pendingOutputReview } from '@farmslot/review-dispatch';

export type LiveArtifactRefreshRun = Pick<Run, 'status' | 'decisions'>;

/** Capturing again can retire a result review, so only working runs refresh automatically. */
export function liveArtifactRefreshActive(run: LiveArtifactRefreshRun | null | undefined): boolean {
  return Boolean(
    run &&
    !isTerminalRunStatus(run.status) &&
    !isHeldForResultDecision(run) &&
    !awaitsHumanDecision(run) &&
    !pendingOutputReview(run),
  );
}

/** The live artifact explorer pulls a run's files from its slot at most this often. */
export const LIVE_ARTIFACT_REFRESH_INTERVAL_MS = 20_000;

export interface LiveArtifactRefreshTarget {
  runId: string;
  /** The run is not terminal. */
  active: boolean;
  /** The artifact panel is expanded. */
  open: boolean;
  /** The slot no longer holds the run's task, or there is no gateway to ask. */
  unavailable: boolean;
}

export interface LiveArtifactRefreshDeps {
  /** `run.refreshMirror`, the same request as the Sync artifacts button. */
  refresh: (runId: string) => Promise<RunRefreshMirrorResult>;
  /** The last background sync's failure, or null after one succeeds. */
  onError: (error: string | null) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  intervalMs?: number;
}

/**
 * Keeps an open artifact explorer's mirror current while its run works. The mirrored
 * copy renders on its own; this only asks the gateway to copy the slot's files again,
 * one request at a time, and never while the panel is collapsed or the run has ended.
 */
export class LiveArtifactRefresh {
  private readonly deps: Required<Omit<LiveArtifactRefreshDeps, 'refresh' | 'onError'>> &
    Pick<LiveArtifactRefreshDeps, 'refresh' | 'onError'>;
  private runId = '';
  private enabled = false;
  private timer: unknown = undefined;
  private inFlight = false;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  /** Bumped when the run changes or the view goes away, so a late reply is dropped. */
  private generation = 0;

  constructor(deps: LiveArtifactRefreshDeps) {
    this.deps = {
      now: () => Date.now(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      intervalMs: LIVE_ARTIFACT_REFRESH_INTERVAL_MS,
      ...deps,
    };
  }

  update(target: LiveArtifactRefreshTarget): void {
    if (target.runId !== this.runId) {
      this.cancelTimer();
      this.runId = target.runId;
      this.generation++;
      this.inFlight = false;
      this.lastStartedAt = Number.NEGATIVE_INFINITY;
      this.deps.onError(null);
    }
    this.enabled = Boolean(target.runId) && target.active && target.open && !target.unavailable;
    if (this.enabled) this.schedule();
    else this.cancelTimer();
  }

  /** The view unmounted: stop, and ignore any reply still on its way. */
  dispose(): void {
    this.enabled = false;
    this.cancelTimer();
    this.generation++;
    this.inFlight = false;
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (!this.enabled || this.inFlight || this.timer !== undefined) return;
    const wait = this.lastStartedAt + this.deps.intervalMs - this.deps.now();
    if (wait <= 0) {
      void this.refresh();
      return;
    }
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      this.schedule();
    }, wait);
  }

  private async refresh(): Promise<void> {
    const runId = this.runId;
    const generation = this.generation;
    this.inFlight = true;
    this.lastStartedAt = this.deps.now();
    let error: string | null = null;
    try {
      const result = await this.deps.refresh(runId);
      if (!result.ok) error = result.reason || 'Could not sync artifacts';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    if (generation !== this.generation) return;
    this.inFlight = false;
    this.deps.onError(error);
    this.schedule();
  }
}
