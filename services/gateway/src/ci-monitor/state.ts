import {
  type BotComment,
  type CIWatchFixProgress,
  type CIWatchFixTrigger,
  type CIWatchPhase,
  Events,
  type RunCiWatchState,
} from '@farmslot/protocol';

import { clearRunActiveTaskFile, getRun, updateRun, updateRunStep } from '../runs/store.js';

type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn = () => {};

export function initCIWatchStateBroadcaster(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
}

export interface CICheckTimelineEntry {
  timestamp: string;
  status: string;
  detail?: string;
}

export interface InlineCIFix {
  attempted: boolean;
  success: boolean;
  attempts: number;
  commitSha?: string;
  /** True only when HEAD advanced during the fix — dedup must gate on this. */
  commitChanged?: boolean;
  durationMs?: number;
  blocked?: boolean;
  blockedReason?: string;
  /** Attempt was refunded (e.g. nudge never delivered) — poll again instead of escalating. */
  retryScheduled?: boolean;
}

export interface CIWatchPhasePatch {
  phase: CIWatchPhase;
  fixInProgress: boolean;
  fixTrigger: CIWatchFixTrigger;
  activeTaskFile?: string | null;
  nextPollAt?: string | null;
  lastSignalAt?: string | null;
  dedupReason?: string | null;
  lastFixCommitSha?: string | null;
  fixProgress?: CIWatchFixProgress;
  timeoutWindowStartedAt?: string;
  lastProgressAt?: string;
  lastProgressReason?: string;
  // Persisted as part of step.outputs so consumers reading step state mid-case
  // (e.g. createRetrospectiveForRun called inside CI_WATCH before its return)
  // see the terminal verdict instead of inferring "unknown" from outputs.result
  // being undefined. Mirrors CIOutcome.result.
  result?: 'passed' | 'failed' | 'blocked' | 'comments' | 'aborted' | 'timeout';
}

export interface CIOutcome {
  result: 'passed' | 'failed' | 'blocked' | 'comments' | 'aborted' | 'timeout';
  failedChecks: string[];
  phase?: CIWatchPhase;
  fixInProgress?: boolean;
  fixTrigger?: CIWatchFixTrigger;
  activeTaskFile?: string | null;
  nextPollAt?: string | null;
  lastSignalAt?: string | null;
  dedupReason?: string | null;
  lastFixCommitSha?: string | null;
  fixProgress?: CIWatchFixProgress;
  timeoutWindowStartedAt?: string;
  lastProgressAt?: string;
  lastProgressReason?: string;
  pollCount: number;
  pollIntervalMs?: number;
  lastCheckedAt?: string;
  totalDurationMs: number;
  checkTimeline: CICheckTimelineEntry[];
  actionableBotCommentCount: number;
  actionableBotCommentDedupedCount?: number;
  inlineFixAttempts?: number;
  inlineFixTotalAttempts?: number;
  inlineFixDedupedSkips?: number;
  /** Which follow-up flow was requested (e.g. 'dispatch-update-branch', 'dispatch-pr-complete') */
  dispatchAction?: string;
  /** Inline CI fix tracking (when worker session was nudged instead of full pr-complete) */
  inlineFix?: InlineCIFix;
}

// ADR-027 Phase 1: ci-watch dedup + counters persist on `Run.ciWatchState` so they
// survive gateway restart. Read via `readDedup`; mutate via `mutateDedup` which
// writes through `updateRun` → `persist(run)`.
export function emptyCiWatchState(): RunCiWatchState {
  return { consecutiveAttempts: 0, totalAttempts: 0, skips: 0 };
}

export function buildCIWatchCheckFingerprint(
  checks: Array<{ name: string; status: string; watchName?: string }>,
): string {
  return checks
    .map((check) => `${check.watchName || check.name}:${check.status}`)
    .sort()
    .join('\n');
}

export function detectCIWatchProgress(
  previous: { checkFingerprint?: string | null; headSha?: string | null },
  next: { checkFingerprint: string; headSha?: string | null },
): string | null {
  if (previous.headSha && next.headSha && previous.headSha !== next.headSha)
    return 'PR head advanced';
  if (previous.checkFingerprint && previous.checkFingerprint !== next.checkFingerprint)
    return 'watched check status changed';
  return null;
}

export function readDedup(runId: string): RunCiWatchState {
  return getRun(runId)?.ciWatchState ?? emptyCiWatchState();
}

/** Operator chose Retry CI — allow inline fix another consecutive-attempt window. */
export function resetInlineFixConsecutiveAttempts(runId: string): void {
  mutateDedup(runId, (s) => {
    s.consecutiveAttempts = 0;
  });
}

// Mutators must replace nested objects wholesale (e.g. `s.dedup = { signature, commitSha }`)
// rather than mutating fields in-place — the spread below is shallow.
export function mutateDedup(runId: string, mutator: (s: RunCiWatchState) => void): RunCiWatchState {
  const run = getRun(runId);
  if (!run) return emptyCiWatchState();
  const state: RunCiWatchState = { ...(run.ciWatchState ?? emptyCiWatchState()) };
  mutator(state);
  updateRun(runId, { ciWatchState: state });
  return state;
}

function botSignature(comments: BotComment[]): string {
  return comments
    .map((c) => `${c.author}|${c.createdAt}|${c.bodyPreview}`)
    .sort()
    .join('\u0000');
}

function fixInputSignature(comments: BotComment[], failedChecks: string[]): string {
  const c = botSignature(comments);
  const f = [...failedChecks].sort().join('\u0000');
  return `${c}::${f}`;
}

export function isInlineFixRedundant(
  runId: string,
  comments: BotComment[],
  failedChecks: string[],
  headSha: string | null,
): boolean {
  if (!headSha) return false;
  const prev = readDedup(runId).dedup;
  if (!prev) return false;
  if (prev.commitSha !== headSha) return false;
  return prev.signature === fixInputSignature(comments, failedChecks);
}

export function recordInlineFixSuccess(
  runId: string,
  comments: BotComment[],
  failedChecks: string[],
  commitSha?: string,
): void {
  if (!commitSha) return;
  const signature = fixInputSignature(comments, failedChecks);
  mutateDedup(runId, (s) => {
    s.dedup = { signature, commitSha };
    s.consecutiveAttempts = 0;
  });
}

export function mergeCIWatchOutputPatch(
  runId: string,
  patch: Partial<CIWatchPhasePatch>,
  detail?: string,
): void {
  const run = getRun(runId);
  if (!run) return;
  const step = run.steps.find((s) => s.name === 'ci-watch');
  const outputs = { ...((step?.outputs ?? {}) as Record<string, unknown>), ...patch };
  updateRunStep(runId, 'ci-watch', {
    ...(detail !== undefined ? { detail } : {}),
    outputs,
  });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
}

export function triggerForInlineFix(
  comments: BotComment[],
  failedChecks: string[],
): CIWatchFixTrigger {
  if (failedChecks.length > 0) return 'failed_checks';
  if (comments.length > 0) return 'bot_comments';
  return null;
}

export function clearInlineFixState(runId: string, patch: Partial<CIWatchPhasePatch>): void {
  const activeTaskFile = readCIWatchPhaseSnapshot(runId).activeTaskFile;
  if (activeTaskFile) clearRunActiveTaskFile(runId, activeTaskFile);
  mergeCIWatchOutputPatch(runId, {
    fixInProgress: false,
    fixTrigger: null,
    activeTaskFile: null,
    nextPollAt: null,
    ...patch,
  });
}

export function readCIWatchPhaseSnapshot(runId: string): Partial<CIWatchPhasePatch> {
  const step = getRun(runId)?.steps.find((s) => s.name === 'ci-watch');
  const out = (step?.outputs ?? {}) as Partial<CIWatchPhasePatch>;
  return {
    phase: out.phase,
    fixInProgress: out.fixInProgress,
    fixTrigger: out.fixTrigger,
    activeTaskFile: out.activeTaskFile,
    nextPollAt: out.nextPollAt,
    lastSignalAt: out.lastSignalAt,
    dedupReason: out.dedupReason,
    lastFixCommitSha: out.lastFixCommitSha,
    fixProgress: out.fixProgress,
    timeoutWindowStartedAt: out.timeoutWindowStartedAt,
    lastProgressAt: out.lastProgressAt,
    lastProgressReason: out.lastProgressReason,
  };
}

export function parseCIFixProgress(markdown: string): CIWatchFixProgress | undefined {
  const checkboxLines = markdown
    .split('\n')
    .map((line) => {
      const match = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
      if (!match) return null;
      return { checked: match[1].toLowerCase() === 'x', label: match[2].trim() };
    })
    .filter((line): line is { checked: boolean; label: string } => !!line);

  if (checkboxLines.length === 0) return undefined;
  const completed = checkboxLines.filter((line) => line.checked).length;
  const currentLabel = checkboxLines.find((line) => !line.checked)?.label ?? null;
  return { completed, total: checkboxLines.length, currentLabel };
}

/**
 * Split actionable comments into kept (new/changed) and dropped (already handled).
 * Whole-set semantics: if the current comments match the last-successfully-fixed
 * signature AND the branch HEAD hasn't advanced, all are dropped.
 */
export function filterDedupedComments(
  runId: string,
  comments: BotComment[],
  failedChecks: string[],
  headSha: string | null,
): { kept: BotComment[]; dropped: BotComment[] } {
  if (comments.length === 0) return { kept: [], dropped: [] };
  if (isInlineFixRedundant(runId, comments, failedChecks, headSha)) {
    return { kept: [], dropped: comments };
  }
  return { kept: comments, dropped: [] };
}
