// ci-monitor.ts — Post-dispatch CI monitoring: poll checks, detect review comments, create decisions
// Reuses prStatus() from methods/pr.ts which already handles watch_checks filtering + bot comment matching.

import { randomUUID } from 'node:crypto';

import { type CIWatchPhase, Events, type PRStatus, type RunDecision } from '@farmslot/protocol';

import { loadProjectVars } from '../core/config.js';

import {
  getSlotHeadSha,
  isInlineFixDedupedNow,
  rerunFailedChecks,
  tryInlineCIFix,
} from './inline-fix.js';
import {
  buildCIWatchCheckFingerprint,
  type CICheckTimelineEntry,
  type CIOutcome,
  type CIWatchPhasePatch,
  detectCIWatchProgress,
  filterDedupedComments,
  initCIWatchStateBroadcaster,
  type InlineCIFix,
  mergeCIWatchOutputPatch,
  mutateDedup,
  readCIWatchPhaseSnapshot,
  readDedup,
  recordInlineFixSuccess,
} from './state.js';
export type { CICheckTimelineEntry, CIOutcome, InlineCIFix } from './state.js';
export {
  buildCIWatchCheckFingerprint,
  detectCIWatchProgress,
  parseCIFixProgress,
} from './state.js';
import { loadFleetStatus, setPrHealthOverlay } from '../fleet/state.js';
import { computePRRecommendation, prStatus } from '../methods/pr.js';
import { getRun, updateRun, updateRunStep } from '../runs/store.js';

type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn = () => {};

export function initCIMonitor(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
  initCIWatchStateBroadcaster(broadcast);
}

interface CIMonitorConfig {
  pollIntervalMs: number;
  maxPollTimeMs: number;
  maxTotalPollTimeMs: number;
  autoDispatch: {
    testFailures: boolean;
    mergeConflicts: boolean;
    botComments: boolean;
  };
}

const DEFAULT_CI_CONFIG: CIMonitorConfig = {
  pollIntervalMs: 180_000, // 3min — conservative default to preserve GitHub quota; projects override via ci_watch.poll_interval_s
  maxPollTimeMs: 120 * 60_000, // 2 hours
  maxTotalPollTimeMs: 6 * 60 * 60_000, // 6 hours absolute cap across progress resets
  autoDispatch: {
    testFailures: true,
    mergeConflicts: true,
    botComments: true,
  },
};

// Decision wait — blocked CI monitors await resolution
const ciDecisionResolvers = new Map<string, (actionId: string) => void>();

export function resolveCIDecision(decisionId: string, actionId: string): void {
  const resolver = ciDecisionResolvers.get(decisionId);
  if (resolver) {
    resolver(actionId);
    ciDecisionResolvers.delete(decisionId);
  }
}

// Per-run active poll waker — resolves `pokeablePoll` early when called
const ciPollWakers = new Map<string, () => void>();

// Per-run last-poke timestamp (rate-limit guard)
const ciPokeCooldown = new Map<string, number>();

// Minimum gap between pokes per run (anti-hammer)
const POKE_MIN_GAP_MS = 5_000;

/** Force the active `pokeablePoll` for this run to resolve early. */
export function pokeCIPoll(runId: string): { ok: boolean; woken?: boolean; reason?: string } {
  const now = Date.now();
  const last = ciPokeCooldown.get(runId) ?? 0;
  if (now - last < POKE_MIN_GAP_MS) {
    const wait = Math.ceil((POKE_MIN_GAP_MS - (now - last)) / 1000);
    return { ok: false, reason: `Poke rate-limited — try again in ${wait}s` };
  }
  const wake = ciPollWakers.get(runId);
  if (!wake) return { ok: true, woken: false };
  ciPokeCooldown.set(runId, now);
  wake();
  return { ok: true, woken: true };
}

/** Resolves with true when resolved early via poke(), false when the timeout fires. */
function pokeablePoll(runId: string, ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), ms);
    let done = false;
    function finish(wasPoked: boolean) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ciPollWakers.delete(runId);
      resolve(wasPoked);
    }
    ciPollWakers.set(runId, () => finish(true));
    signal.addEventListener(
      'abort',
      () => {
        if (done) return;
        // Resolve (not reject) — lets the monitorCI while-loop detect
        // signal.aborted on its next check and return buildOutcome('aborted')
        // cleanly, so the CI_WATCH step completes normally → run status='done'.
        finish(false);
      },
      { once: true },
    );
  });
}

export async function monitorCI(
  runId: string,
  prNumber: number,
  ciRepo: string,
  signal: AbortSignal,
): Promise<CIOutcome> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const config = await loadCIConfig(run.project);
  const startedAt = Date.now();
  const initialState = readDedup(runId);
  let timeoutWindowStartedAt = Date.parse(initialState.timeoutWindowStartedAt ?? '');
  if (!Number.isFinite(timeoutWindowStartedAt)) timeoutWindowStartedAt = startedAt;
  let lastCheckFingerprint = initialState.lastCheckFingerprint ?? null;
  let lastHeadSha = initialState.lastHeadSha ?? null;

  // Accumulated metrics
  let pollCount = 0;
  const checkTimeline: CICheckTimelineEntry[] = [];
  let lastBotCommentCount = 0;
  let lastBotCommentDedupedCount = 0;
  let lastInlineCIFix: InlineCIFix | undefined;
  // When the last pokeablePoll was resolved early by a poke(), force the next
  // prStatus to bypass the 30s gh-cache so operator refreshes see fresh data.
  let forceNextRefresh = false;

  const syncTimeoutProgressState = (patch?: {
    timeoutWindowStartedAt?: number;
    lastProgressAt?: string;
    lastProgressReason?: string;
    checkFingerprint?: string;
    headSha?: string | null;
  }) => {
    const windowStart = patch?.timeoutWindowStartedAt ?? timeoutWindowStartedAt;
    const windowStartIso = new Date(windowStart).toISOString();
    if (patch?.timeoutWindowStartedAt != null)
      timeoutWindowStartedAt = patch.timeoutWindowStartedAt;
    if (patch?.checkFingerprint !== undefined) lastCheckFingerprint = patch.checkFingerprint;
    if (patch?.headSha !== undefined) lastHeadSha = patch.headSha;
    mutateDedup(runId, (s) => {
      s.timeoutWindowStartedAt = windowStartIso;
      if (patch?.lastProgressAt) s.lastProgressAt = patch.lastProgressAt;
      if (patch?.lastProgressReason) s.lastProgressReason = patch.lastProgressReason;
      if (lastCheckFingerprint != null) s.lastCheckFingerprint = lastCheckFingerprint;
      if (lastHeadSha !== undefined) s.lastHeadSha = lastHeadSha;
    });
    return {
      timeoutWindowStartedAt: windowStartIso,
      lastProgressAt: patch?.lastProgressAt ?? readDedup(runId).lastProgressAt,
      lastProgressReason: patch?.lastProgressReason ?? readDedup(runId).lastProgressReason,
    };
  };

  const markTimeoutProgress = (
    reason: string,
    opts?: { checkFingerprint?: string; headSha?: string | null },
  ) => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    return syncTimeoutProgressState({
      timeoutWindowStartedAt: now,
      lastProgressAt: nowIso,
      lastProgressReason: reason,
      checkFingerprint: opts?.checkFingerprint,
      headSha: opts?.headSha,
    });
  };

  const initialTimeoutState = syncTimeoutProgressState();
  mergeCIWatchOutputPatch(runId, {
    phase: 'polling',
    fixInProgress: false,
    fixTrigger: null,
    activeTaskFile: null,
    nextPollAt: null,
    dedupReason: null,
    ...initialTimeoutState,
  });

  const buildOutcome = (
    result: CIOutcome['result'],
    failedChecks: string[] = [],
    dispatchAction?: string,
  ): CIOutcome => {
    ciPokeCooldown.delete(runId);
    const phaseSnapshot = {
      ...readCIWatchPhaseSnapshot(runId),
      phase: result === 'blocked' ? ('blocked' as const) : ('done' as const),
      fixInProgress: false,
      fixTrigger: null,
      activeTaskFile: null,
      nextPollAt: null,
      timeoutWindowStartedAt: readDedup(runId).timeoutWindowStartedAt,
      lastProgressAt: readDedup(runId).lastProgressAt,
      lastProgressReason: readDedup(runId).lastProgressReason,
      // Persist final verdict so step.outputs.result is available immediately
      // (matters for createRetrospectiveForRun which runs inside the CI_WATCH
      // case, before the case-return propagates outputs to step state).
      result,
    };
    mergeCIWatchOutputPatch(runId, phaseSnapshot);
    return {
      // result comes from phaseSnapshot (persisted form); failedChecks is return-only
      ...phaseSnapshot,
      failedChecks,
      pollCount,
      pollIntervalMs: config.pollIntervalMs,
      lastCheckedAt: checkTimeline.length
        ? checkTimeline[checkTimeline.length - 1].timestamp
        : undefined,
      timeoutWindowStartedAt: readDedup(runId).timeoutWindowStartedAt,
      lastProgressAt: readDedup(runId).lastProgressAt,
      lastProgressReason: readDedup(runId).lastProgressReason,
      totalDurationMs: Date.now() - startedAt,
      checkTimeline,
      actionableBotCommentCount: lastBotCommentCount,
      actionableBotCommentDedupedCount: lastBotCommentDedupedCount,
      inlineFixAttempts: readDedup(runId).consecutiveAttempts,
      inlineFixTotalAttempts: readDedup(runId).totalAttempts,
      inlineFixDedupedSkips: readDedup(runId).skips,
      dispatchAction,
      ...(lastInlineCIFix ? { inlineFix: lastInlineCIFix } : {}),
    };
  };

  const persistRunningState = (
    checkSummary: { passed: number; failed: number; pending: number; total: number },
    recommendation: string,
    passedNames: string[],
    failedNames: string[],
    pendingNames: string[],
  ) => {
    const phaseSnapshot = readCIWatchPhaseSnapshot(runId);
    updateRunStep(runId, 'ci-watch', {
      detail: recommendation,
      outputs: {
        ...phaseSnapshot,
        checkSummary,
        recommendation,
        passedNames,
        failedNames,
        pendingNames,
        pollCount,
        pollIntervalMs: config.pollIntervalMs,
        lastCheckedAt: checkTimeline.length
          ? checkTimeline[checkTimeline.length - 1].timestamp
          : undefined,
        timeoutWindowStartedAt: readDedup(runId).timeoutWindowStartedAt,
        lastProgressAt: readDedup(runId).lastProgressAt,
        lastProgressReason: readDedup(runId).lastProgressReason,
        checkTimeline: [...checkTimeline],
        actionableBotCommentCount: lastBotCommentCount,
        actionableBotCommentDedupedCount: lastBotCommentDedupedCount,
        inlineFixAttempts: readDedup(runId).consecutiveAttempts,
        inlineFixTotalAttempts: readDedup(runId).totalAttempts,
        inlineFixDedupedSkips: readDedup(runId).skips,
        ...(lastInlineCIFix ? { inlineFix: lastInlineCIFix } : {}),
      },
    });
  };

  const waitForNextPoll = async (
    phase: CIWatchPhase = 'polling',
    extra: Partial<CIWatchPhasePatch> = {},
  ): Promise<boolean> => {
    mergeCIWatchOutputPatch(runId, {
      phase,
      fixInProgress: false,
      fixTrigger: null,
      activeTaskFile: null,
      nextPollAt: new Date(Date.now() + config.pollIntervalMs).toISOString(),
      timeoutWindowStartedAt: readDedup(runId).timeoutWindowStartedAt,
      lastProgressAt: readDedup(runId).lastProgressAt,
      lastProgressReason: readDedup(runId).lastProgressReason,
      ...extra,
    });
    return pokeablePoll(runId, config.pollIntervalMs, signal);
  };

  console.log(
    `[ci-monitor] started for run ${runId.slice(0, 8)} PR #${prNumber} repo=${ciRepo} poll=${config.pollIntervalMs / 1000}s`,
  );

  while (!signal.aborted) {
    pollCount++;
    mergeCIWatchOutputPatch(runId, {
      phase: 'polling',
      fixInProgress: false,
      fixTrigger: null,
      activeTaskFile: null,
      nextPollAt: null,
      timeoutWindowStartedAt: readDedup(runId).timeoutWindowStartedAt,
      lastProgressAt: readDedup(runId).lastProgressAt,
      lastProgressReason: readDedup(runId).lastProgressReason,
    });

    // Single call — reuses the same logic as pr-monitor.sh / prStatus
    let pr: PRStatus;
    const forceThisPoll = forceNextRefresh;
    forceNextRefresh = false;
    try {
      const result = await prStatus({ pr: prNumber, project: run!.project, force: forceThisPoll });
      pr = result.pr;
    } catch (err) {
      console.warn(
        `[ci-monitor] run ${runId.slice(0, 8)} — prStatus failed: ${(err as Error).message}`,
      );
      checkTimeline.push({
        timestamp: new Date().toISOString(),
        status: 'poll-error',
        detail: (err as Error).message,
      });
      forceNextRefresh = await waitForNextPoll('polling');
      continue;
    }

    const {
      checkSummary,
      allPassed,
      anyFailed,
      failedNames,
      actionableBotComments,
      recommendation: rawRecommendation,
      merged,
      mergeConflict,
    } = pr;
    const headShaNow = run.slotId ? await getSlotHeadSha(run.slotId) : null;
    const checkFingerprint = buildCIWatchCheckFingerprint(pr.checks);
    const progressReason = detectCIWatchProgress(
      { checkFingerprint: lastCheckFingerprint, headSha: lastHeadSha },
      { checkFingerprint, headSha: headShaNow },
    );
    if (progressReason) {
      markTimeoutProgress(progressReason, { checkFingerprint, headSha: headShaNow });
    } else if (lastCheckFingerprint == null || lastHeadSha !== headShaNow) {
      syncTimeoutProgressState({ checkFingerprint, headSha: headShaNow });
    }
    const { kept: effectiveActionable, dropped: dedupedActionable } = filterDedupedComments(
      runId,
      actionableBotComments,
      [],
      headShaNow,
    );
    let recommendation = rawRecommendation;
    if (
      rawRecommendation === 'NEEDS_ATTENTION' &&
      dedupedActionable.length > 0 &&
      effectiveActionable.length === 0 &&
      !anyFailed &&
      !mergeConflict
    ) {
      recommendation = computePRRecommendation({
        prState: pr.prState,
        workerActive: false,
        anyFailed: false,
        mergeConflict: false,
        actionableCount: 0,
        allPassed,
        approved: pr.reviewDecision === 'APPROVED',
        familyContext: null,
      });
      mutateDedup(runId, (s) => {
        s.skips += 1;
      });
      console.log(
        `[ci-monitor] run ${runId.slice(0, 8)} — dedup-filter dropped ${dedupedActionable.length} actionable at HEAD=${headShaNow?.slice(0, 8)} → recommendation ${rawRecommendation}→${recommendation}`,
      );
      checkTimeline.push({
        timestamp: new Date().toISOString(),
        status: 'actionable-deduped',
        detail: `${dedupedActionable.length} comments filtered`,
      });
    }
    lastBotCommentCount = effectiveActionable.length;
    lastBotCommentDedupedCount = dedupedActionable.length;
    checkTimeline.push({
      timestamp: new Date().toISOString(),
      status: `${checkSummary.passed}/${checkSummary.total} passed, ${checkSummary.failed} failed, ${checkSummary.pending} pending`,
      detail: recommendation,
    });
    console.log(
      `[ci-monitor] run ${runId.slice(0, 8)} PR #${prNumber}: ${checkSummary.passed}/${checkSummary.total} watched passed, ${checkSummary.failed} failed, ${checkSummary.pending} pending → ${recommendation}${dedupedActionable.length > 0 ? ` (deduped ${dedupedActionable.length} actionable)` : ''}`,
    );
    const passedNames = pr.checks.filter((c) => c.status === 'pass').map((c) => c.name);
    const pendingNames = pr.checks.filter((c) => c.status === 'pending').map((c) => c.name);
    persistRunningState(checkSummary, recommendation, passedNames, failedNames, pendingNames);
    broadcastFn(Events.CI_CHECK_UPDATED, {
      runId,
      prNumber,
      checkSummary,
      recommendation,
      passedNames,
      failedNames,
      pendingNames,
      pollCount,
      pollIntervalMs: config.pollIntervalMs,
      lastCheckedAt: checkTimeline[checkTimeline.length - 1]?.timestamp,
      ...readCIWatchPhaseSnapshot(runId),
    });

    // Update PR health overlay for fleet map
    if (run.slotId) {
      setPrHealthOverlay(run.slotId, {
        pr: prNumber,
        conflict: mergeConflict,
        ciPassed: checkSummary.passed,
        ciFailed: checkSummary.failed,
        ciPending: checkSummary.pending,
        ciTotal: checkSummary.total,
        updatedAt: new Date().toISOString(),
      });
      const fleet = await loadFleetStatus(true);
      broadcastFn(Events.FLEET_UPDATED, { fleet });
    }

    // Already merged or closed — we're done
    if (merged || pr.prState === 'CLOSED') {
      console.log(`[ci-monitor] run ${runId.slice(0, 8)} — PR ${pr.prState}`);
      return buildOutcome('passed');
    }

    // Merge conflict — prefer merge-main (lighter), fallback to pr-complete
    if (mergeConflict) {
      console.log(`[ci-monitor] run ${runId.slice(0, 8)} — merge conflict detected`);
      const autoAction = pickCIAutoDispatchAction('merge_conflict', [], config);
      if (autoAction) {
        console.log(
          `[ci-monitor] run ${runId.slice(0, 8)} — auto-dispatching ${autoAction} for merge conflict`,
        );
        return buildOutcome('failed', ['MERGE_CONFLICT'], autoAction);
      }
      const actionId = await createCIDecision(
        runId,
        'merge_conflict',
        `PR #${prNumber} has merge conflicts`,
        [
          { id: 'dispatch-merge-main', label: 'Dispatch merge-main', style: 'primary' },
          { id: 'dispatch-pr-complete', label: 'Dispatch pr-complete', style: 'secondary' },
          { id: 'skip', label: 'Skip (manual)', style: 'secondary' },
        ],
      );
      if (actionId === 'dispatch-merge-main' || actionId === 'dispatch-pr-complete')
        return buildOutcome('failed', ['MERGE_CONFLICT'], actionId);
      return buildOutcome('passed');
    }

    // All watched checks passed
    if (allPassed) {
      // Check for actionable bot comments (bugbot, cursor-bugbot etc.) — effective = post-dedup
      if (effectiveActionable.length > 0) {
        const labels = [...new Set(effectiveActionable.map((c) => c.label))].join(', ');
        console.log(
          `[ci-monitor] run ${runId.slice(0, 8)} — CI passed but ${effectiveActionable.length} actionable comment(s): ${labels}`,
        );

        // Try inline CI fix before creating a decision
        const inlineFix = await tryInlineCIFix(
          runId,
          run.slotId,
          effectiveActionable,
          [],
          prNumber,
          ciRepo,
          signal,
        );
        if (inlineFix?.success) {
          checkTimeline.push({
            timestamp: new Date().toISOString(),
            status: 'inline-ci-fix',
            detail: `commit ${inlineFix.commitSha?.slice(0, 8)}${inlineFix.commitChanged ? '' : ' (no push)'}`,
          });
          lastInlineCIFix = inlineFix;
          if (inlineFix.commitChanged) {
            recordInlineFixSuccess(runId, effectiveActionable, [], inlineFix.commitSha);
            markTimeoutProgress('inline fix committed', {
              checkFingerprint,
              headSha: inlineFix.commitSha ?? headShaNow,
            });
          }
          console.log(
            `[ci-monitor] run ${runId.slice(0, 8)} — inline CI fix succeeded, re-entering CI poll`,
          );
          forceNextRefresh = await waitForNextPoll('polling');
          continue;
        }
        if (inlineFix) {
          lastInlineCIFix = inlineFix;
          if (inlineFix.blocked) {
            checkTimeline.push({
              timestamp: new Date().toISOString(),
              status: 'inline-ci-fix-blocked',
              detail: inlineFix.blockedReason ?? `attempt ${inlineFix.attempts}`,
            });
            return buildOutcome('blocked', ['INLINE_FIX_BLOCKED']);
          }
          checkTimeline.push({
            timestamp: new Date().toISOString(),
            status: 'inline-ci-fix-failed',
            detail: `attempt ${inlineFix.attempts}`,
          });
        }

        const autoAction = pickCIAutoDispatchAction('bot_comments', [], config);
        if (autoAction) {
          console.log(
            `[ci-monitor] run ${runId.slice(0, 8)} — auto-dispatching ${autoAction} for actionable bot comments`,
          );
          return buildOutcome('comments', [], autoAction);
        }

        // Inline fix failed or not applicable — fall through to decision
        const actionId = await createCIDecision(
          runId,
          'review_comments',
          `CI passed but ${effectiveActionable.length} actionable comment(s) on PR #${prNumber} (${labels})`,
          [
            { id: 'dispatch-pr-complete', label: 'Dispatch pr-complete', style: 'primary' },
            { id: 'skip', label: 'Skip (manual)', style: 'secondary' },
            { id: 'dismiss', label: 'Dismiss comments', style: 'secondary' },
          ],
        );
        if (actionId === 'dispatch-pr-complete') {
          return buildOutcome('comments', [], actionId);
        }
      } else if (dedupedActionable.length > 0) {
        // All actionable comments already handled — keep polling for CI/merge
        forceNextRefresh = await waitForNextPoll('deduped', {
          dedupReason: `${dedupedActionable.length} comments filtered`,
        });
        continue;
      }

      console.log(
        `[ci-monitor] run ${runId.slice(0, 8)} — all watched checks passed, no actionable comments`,
      );
      return buildOutcome('passed');
    }

    // Any watched check failed
    if (anyFailed) {
      console.log(
        `[ci-monitor] run ${runId.slice(0, 8)} — ${checkSummary.failed} watched check(s) failed: ${failedNames.join(', ')}`,
      );

      if (await isInlineFixDedupedNow(runId, run.slotId, [], failedNames)) {
        checkTimeline.push({
          timestamp: new Date().toISOString(),
          status: 'inline-ci-fix-deduped',
          detail: 'no change since last fix',
        });
        forceNextRefresh = await waitForNextPoll('deduped', {
          fixTrigger: 'failed_checks',
          dedupReason: 'no change since last fix',
        });
        continue;
      }

      // Try inline CI fix before creating a decision
      const inlineFix = await tryInlineCIFix(
        runId,
        run.slotId,
        [],
        failedNames,
        prNumber,
        ciRepo,
        signal,
      );
      if (inlineFix?.success) {
        checkTimeline.push({
          timestamp: new Date().toISOString(),
          status: 'inline-ci-fix',
          detail: `commit ${inlineFix.commitSha?.slice(0, 8)}${inlineFix.commitChanged ? '' : ' (no push)'}`,
        });
        lastInlineCIFix = inlineFix;
        if (inlineFix.commitChanged) {
          recordInlineFixSuccess(runId, [], failedNames, inlineFix.commitSha);
          markTimeoutProgress('inline fix committed', {
            checkFingerprint,
            headSha: inlineFix.commitSha ?? headShaNow,
          });
        }
        console.log(
          `[ci-monitor] run ${runId.slice(0, 8)} — inline CI fix succeeded (CI failed), re-entering CI poll`,
        );
        forceNextRefresh = await waitForNextPoll('polling');
        continue;
      }
      if (inlineFix) {
        lastInlineCIFix = inlineFix;
        if (inlineFix.blocked) {
          checkTimeline.push({
            timestamp: new Date().toISOString(),
            status: 'inline-ci-fix-blocked',
            detail: inlineFix.blockedReason ?? `attempt ${inlineFix.attempts}`,
          });
          return buildOutcome('blocked', failedNames);
        }
        checkTimeline.push({
          timestamp: new Date().toISOString(),
          status: 'inline-ci-fix-failed',
          detail: `attempt ${inlineFix.attempts}`,
        });
      }

      const autoAction = pickCIAutoDispatchAction('ci_failed', failedNames, config);
      if (autoAction) {
        console.log(
          `[ci-monitor] run ${runId.slice(0, 8)} — auto-dispatching ${autoAction} for failed checks`,
        );
        return buildOutcome('failed', failedNames, autoAction);
      }

      const actionId = await createCIDecision(
        runId,
        'ci_failed',
        `${checkSummary.failed} CI check(s) failed on PR #${prNumber}: ${failedNames.join(', ')}`,
        [
          { id: 'dispatch-pr-complete', label: 'Dispatch pr-complete to fix', style: 'primary' },
          { id: 'retry', label: 'Retry CI', style: 'secondary' },
          { id: 'skip', label: 'Skip (manual)', style: 'secondary' },
          { id: 'abort', label: 'Abort', style: 'danger' },
        ],
        { checks: pr.checks },
      );
      if (actionId === 'abort') return buildOutcome('aborted');
      if (actionId === 'dispatch-pr-complete') return buildOutcome('failed', failedNames, actionId);
      if (actionId === 'retry') {
        await rerunFailedChecks(prNumber, ciRepo);
        forceNextRefresh = await waitForNextPoll('polling', { dedupReason: 'CI rerun requested' });
        continue;
      }
      return buildOutcome('passed');
    }

    // Still pending — also check for actionable comments while waiting (effective = post-dedup)
    if (effectiveActionable.length > 0) {
      const labels = [...new Set(effectiveActionable.map((c) => c.label))].join(', ');
      console.log(
        `[ci-monitor] run ${runId.slice(0, 8)} — ${effectiveActionable.length} actionable comment(s) while CI pending: ${labels}`,
      );

      // Try inline CI fix before creating a decision
      const inlineFix = await tryInlineCIFix(
        runId,
        run.slotId,
        effectiveActionable,
        [],
        prNumber,
        ciRepo,
        signal,
      );
      if (inlineFix?.success) {
        checkTimeline.push({
          timestamp: new Date().toISOString(),
          status: 'inline-ci-fix',
          detail: `commit ${inlineFix.commitSha?.slice(0, 8)}${inlineFix.commitChanged ? '' : ' (no push)'}`,
        });
        lastInlineCIFix = inlineFix;
        if (inlineFix.commitChanged) {
          recordInlineFixSuccess(runId, effectiveActionable, [], inlineFix.commitSha);
          markTimeoutProgress('inline fix committed', {
            checkFingerprint,
            headSha: inlineFix.commitSha ?? headShaNow,
          });
        }
        console.log(
          `[ci-monitor] run ${runId.slice(0, 8)} — inline CI fix succeeded (CI pending), re-entering CI poll`,
        );
        forceNextRefresh = await waitForNextPoll('polling');
        continue;
      }
      if (inlineFix) {
        lastInlineCIFix = inlineFix;
        if (inlineFix.blocked) {
          checkTimeline.push({
            timestamp: new Date().toISOString(),
            status: 'inline-ci-fix-blocked',
            detail: inlineFix.blockedReason ?? `attempt ${inlineFix.attempts}`,
          });
          return buildOutcome('blocked', ['INLINE_FIX_BLOCKED']);
        }
        checkTimeline.push({
          timestamp: new Date().toISOString(),
          status: 'inline-ci-fix-failed',
          detail: `attempt ${inlineFix.attempts}`,
        });
      }

      const autoAction = pickCIAutoDispatchAction('bot_comments_early', [], config);
      if (autoAction) {
        console.log(
          `[ci-monitor] run ${runId.slice(0, 8)} — auto-dispatching ${autoAction} for early actionable bot comments`,
        );
        return buildOutcome('comments', [], autoAction);
      }

      // Inline fix failed or not applicable — fall through to decision
      const actionId = await createCIDecision(
        runId,
        'review_comments_early',
        `${effectiveActionable.length} actionable comment(s) on PR #${prNumber} (${labels}) — CI still pending`,
        [
          { id: 'dispatch-pr-complete', label: 'Dispatch pr-complete now', style: 'primary' },
          { id: 'wait', label: 'Wait for CI first', style: 'secondary' },
        ],
      );
      if (actionId === 'dispatch-pr-complete') {
        return buildOutcome('comments', [], actionId);
      }
    }

    // Timeout check. The short window resets on watched progress; the total
    // window prevents endless fix/check loops.
    const now = Date.now();
    const progressWindowExpired = now - timeoutWindowStartedAt > config.maxPollTimeMs;
    const totalWindowExpired = now - startedAt > config.maxTotalPollTimeMs;
    if (progressWindowExpired || totalWindowExpired) {
      const elapsedMs = progressWindowExpired ? now - timeoutWindowStartedAt : now - startedAt;
      const configuredMs = progressWindowExpired ? config.maxPollTimeMs : config.maxTotalPollTimeMs;
      const reason = progressWindowExpired
        ? 'without watched CI progress'
        : 'absolute CI-watch cap';
      console.log(
        `[ci-monitor] run ${runId.slice(0, 8)} — timed out after ${Math.round(elapsedMs / 60_000)}min (${reason}, limit ${configuredMs / 60000}min)`,
      );
      const pendingNames = pr.checks.filter((c) => c.status === 'pending').map((c) => c.name);
      const failedCheckNames = pr.checks.filter((c) => c.status === 'fail').map((c) => c.name);
      let timeoutDesc = progressWindowExpired
        ? `CI timed out after ${configuredMs / 60000} min without watched progress`
        : `CI timed out after ${configuredMs / 60000} min total`;
      if (pendingNames.length) timeoutDesc += `\nPending: ${pendingNames.join(', ')}`;
      if (failedCheckNames.length) timeoutDesc += `\nFailed: ${failedCheckNames.join(', ')}`;
      const state = readDedup(runId);
      if (state.lastProgressAt)
        timeoutDesc += `\nLast progress: ${state.lastProgressAt}${state.lastProgressReason ? ` (${state.lastProgressReason})` : ''}`;
      const actionId = await createCIDecision(
        runId,
        'ci_timeout',
        timeoutDesc,
        [
          { id: 'continue', label: 'Keep waiting', style: 'primary' },
          { id: 'skip', label: 'Release slot', style: 'secondary' },
          { id: 'abort', label: 'Abort', style: 'danger' },
        ],
        { checks: pr.checks },
      );
      if (actionId === 'abort') return buildOutcome('aborted');
      if (actionId === 'skip') return buildOutcome('timeout');
      // continue — keep polling
    }

    // Sleep before next poll
    forceNextRefresh = await waitForNextPoll('polling');
  }

  return buildOutcome('aborted');
}

// ─── Decision creation + wait ───

async function createCIDecision(
  runId: string,
  reason: string,
  description: string,
  actions: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'danger' }>,
  context?: Record<string, unknown>,
): Promise<string> {
  const run = getRun(runId);
  if (!run) throw new Error('Run not found');

  const type: `ci_${string}` = `ci_${reason}`;
  mergeCIWatchOutputPatch(runId, {
    phase: 'decision_required',
    fixInProgress: false,
    fixTrigger: null,
    activeTaskFile: null,
    nextPollAt: null,
  });

  // Dedup: if a decision of this type was already resolved, return its action
  const resolved = run.decisions.find(
    (d) => d.type === type && d.resolvedAt && shouldReuseResolvedCIDecisionAction(d.resolvedAction),
  );
  if (resolved) return resolved.resolvedAction!;

  // Dedup: if an unresolved decision of this type exists, re-await it
  const pending = run.decisions.find((d) => d.type === type && !d.resolvedAt);
  if (pending) {
    const actionId = await new Promise<string>((resolve) => {
      ciDecisionResolvers.set(pending.id, resolve);
    });
    pending.resolvedAt = new Date().toISOString();
    pending.resolvedAction = actionId;
    updateRun(runId, { status: 'ci-watching', decisions: run.decisions });
    broadcastFn(Events.RUN_DECISION_RESOLVED, { runId, decisionId: pending.id, actionId });
    broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
    return actionId;
  }

  const decision: RunDecision = {
    id: randomUUID(),
    type,
    title: `${run.ticketOrPr || `Run ${runId.slice(0, 8)}`} — ${reason.replace(/_/g, ' ')}`,
    description,
    actions,
    createdAt: new Date().toISOString(),
    ...(context ? { context } : {}),
  };

  run.decisions.push(decision);
  updateRun(runId, { status: 'blocked', decisions: run.decisions });
  broadcastFn(Events.RUN_DECISION_NEW, { runId, decision, slotId: run.slotId });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });

  const autoAction = (() => {
    if (run.mode !== 'validation') return null;
    const ids = new Set(actions.map((a) => a.id));
    if (reason === 'merge_conflict' && ids.has('dispatch-merge-main')) return 'dispatch-merge-main';
    if (
      (reason === 'review_comments' ||
        reason === 'review_comments_early' ||
        reason === 'ci_failed') &&
      ids.has('dispatch-pr-complete')
    )
      return 'dispatch-pr-complete';
    if (reason === 'ci_timeout' && ids.has('skip')) return 'skip';
    if (ids.has('dismiss')) return 'dismiss';
    return null;
  })();
  const actionId =
    autoAction ??
    (await new Promise<string>((resolve) => {
      ciDecisionResolvers.set(decision.id, resolve);
    }));

  decision.resolvedAt = new Date().toISOString();
  decision.resolvedAction = actionId;
  updateRun(runId, { status: 'ci-watching', decisions: run.decisions });
  broadcastFn(Events.RUN_DECISION_RESOLVED, { runId, decisionId: decision.id, actionId });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });

  return actionId;
}

// ─── Helpers ───

async function loadCIConfig(project: string): Promise<CIMonitorConfig> {
  try {
    const pv = await loadProjectVars(project);
    return resolveCIMonitorConfig(pv.projectJson);
  } catch {
    return DEFAULT_CI_CONFIG;
  }
}

export function resolveCIMonitorConfig(projectJson?: unknown): CIMonitorConfig {
  const raw = (projectJson ?? {}) as any;
  const ci = raw?.ci ?? {};
  const ciWatch = raw?.ci_watch ?? {};
  const autoDispatch = ciWatch?.auto_dispatch ?? {};
  const maxPollTimeMs = (ciWatch.max_hold_min ?? ci.timeout_min ?? 120) * 60_000;

  return {
    pollIntervalMs: (ciWatch.poll_interval_s ?? (ci.poll_interval_min ?? 10) * 60) * 1_000,
    maxPollTimeMs,
    maxTotalPollTimeMs:
      (ciWatch.max_total_hold_min ?? Math.max(360, Math.ceil(maxPollTimeMs / 60_000) * 3)) * 60_000,
    autoDispatch: {
      testFailures: autoDispatch.test_failures ?? DEFAULT_CI_CONFIG.autoDispatch.testFailures,
      mergeConflicts: autoDispatch.merge_conflicts ?? DEFAULT_CI_CONFIG.autoDispatch.mergeConflicts,
      botComments: autoDispatch.bot_comments ?? DEFAULT_CI_CONFIG.autoDispatch.botComments,
    },
  };
}

function looksLikeTestFailure(name: string): boolean {
  return /(test|spec|integration|e2e|playwright|cypress|jest|vitest|mocha)/i.test(name);
}

export function pickCIAutoDispatchAction(
  reason: 'merge_conflict' | 'bot_comments' | 'bot_comments_early' | 'ci_failed',
  failedChecks: string[],
  config: Pick<CIMonitorConfig, 'autoDispatch'>,
): 'dispatch-merge-main' | 'dispatch-pr-complete' | null {
  switch (reason) {
    case 'merge_conflict':
      return config.autoDispatch.mergeConflicts ? 'dispatch-merge-main' : null;
    case 'bot_comments':
    case 'bot_comments_early':
      return config.autoDispatch.botComments ? 'dispatch-pr-complete' : null;
    case 'ci_failed':
      // Intentional: in this slice, only test-like failures auto-chain into pr-complete.
      // Lint/typecheck/build failures still fall back to the existing inline-fix/manual decision path.
      return config.autoDispatch.testFailures && failedChecks.some(looksLikeTestFailure)
        ? 'dispatch-pr-complete'
        : null;
    default:
      return null;
  }
}

export function shouldReuseResolvedCIDecisionAction(actionId: string | null | undefined): boolean {
  if (!actionId) return false;
  // Retry/continue/wait are one-shot control actions. Reusing them would turn
  // a resolved CI decision into an implicit infinite loop: the next identical
  // CI state would skip the human gate, immediately pick the old transient
  // action again, and continue without a fresh operator decision.
  return !new Set(['retry', 'continue', 'wait']).has(actionId);
}
