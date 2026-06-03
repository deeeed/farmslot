export function updateFamilyProposalError(
  current: ReadonlyMap<string, string>,
  runId: string,
  message: string | null,
): Map<string, string> {
  const next = new Map(current);
  if (message) next.set(runId, message);
  else next.delete(runId);
  return next;
}

function warnFamilyImprovementProposalTimedOut(runId: string): void {
  console.warn(
    `[family-observability] improvement proposal timed out for run ${runId.slice(0, 8)}`,
  );
}

const PROPOSAL_TIMEOUT_MESSAGE =
  'Analysis is taking longer than expected. It may still complete — check the timeline, or retry.';

interface FamilyImprovementProposalSink {
  getProposingFor: () => ReadonlySet<string>;
  setProposingFor: (runIds: Set<string>) => void;
  setProposalError: (runId: string, message: string | null) => void;
  incrementElapsedTick: () => void;
  warnTimedOut?: (runId: string) => void;
}

export class FamilyImprovementProposalTracker {
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly startedAt = new Map<string, number>();
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sink: FamilyImprovementProposalSink,
    private readonly timeoutMs = 120_000,
  ) {}

  dispose(): void {
    for (const timeout of this.timeouts.values()) clearTimeout(timeout);
    this.timeouts.clear();
    this.startedAt.clear();
    this.stopElapsedTimer();
  }

  start(runId: string): void {
    this.sink.setProposalError(runId, null);
    this.addProposingRun(runId);
    this.startedAt.set(runId, Date.now());
    this.startElapsedTimer();

    const existingTimer = this.timeouts.get(runId);
    if (existingTimer) clearTimeout(existingTimer);
    this.timeouts.set(
      runId,
      setTimeout(() => {
        if (!this.sink.getProposingFor().has(runId)) return;
        (this.sink.warnTimedOut ?? warnFamilyImprovementProposalTimedOut)(runId);
        this.sink.setProposalError(runId, PROPOSAL_TIMEOUT_MESSAGE);
        this.markDone(runId);
      }, this.timeoutMs),
    );
  }

  markDone(runId: string): void {
    if (this.sink.getProposingFor().has(runId)) {
      const next = new Set(this.sink.getProposingFor());
      next.delete(runId);
      this.sink.setProposingFor(next);
    }
    const timeout = this.timeouts.get(runId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(runId);
    }
    this.startedAt.delete(runId);
    if (this.sink.getProposingFor().size === 0) this.stopElapsedTimer();
  }

  setError(runId: string, message: string | null): void {
    this.sink.setProposalError(runId, message);
  }

  elapsedSeconds(runId: string): number {
    const start = this.startedAt.get(runId);
    if (!start) return 0;
    return Math.max(0, Math.floor((Date.now() - start) / 1000));
  }

  private addProposingRun(runId: string): void {
    const next = new Set(this.sink.getProposingFor());
    next.add(runId);
    this.sink.setProposingFor(next);
  }

  private startElapsedTimer(): void {
    if (this.elapsedTimer) return;
    this.elapsedTimer = setInterval(() => {
      this.sink.incrementElapsedTick();
    }, 1000);
  }

  private stopElapsedTimer(): void {
    if (!this.elapsedTimer) return;
    clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
  }
}
