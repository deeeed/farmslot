import type {
  DevInteractiveCompletionAction,
  Run,
  RunCancelResult,
  RunDecision,
  RunForceCompleteResult,
  RunInteractiveDevResolveResult,
  RunProbeWorkerSignalResult,
  RunRehydratePrNumberResult,
} from '@farmslot/protocol';
import { buildRunResolveDecisionParams, failedRunCancelEffects, Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { navigateToPreparedSlot, runSlotPrepareForRun } from '../shared/slot-prepare-client.js';

type Timer = ReturnType<typeof setTimeout> | undefined;

interface ConfirmTimerContext {
  actionsBlocked: () => boolean;
  pendingConfirm: () => string | null;
  setPendingConfirm: (pending: string | null) => void;
  confirmTimer: () => Timer;
  setConfirmTimer: (timer: Timer) => void;
}

export interface RescueLinkageContext {
  actionsBlocked: () => boolean;
  rescueInProgress: () => boolean;
  setRescueInProgress: (inProgress: boolean) => void;
}

export interface RunLifecycleActionContext extends ConfirmTimerContext {
  navigateToRuns: () => void;
}

export async function confirmRunLifecycleAction(
  run: Run,
  action: 'cancel' | 'delete',
  context: RunLifecycleActionContext,
): Promise<void> {
  if (context.actionsBlocked()) return;
  const confirmation = `${action}:${run.id}`;
  if (context.pendingConfirm() !== confirmation) {
    clearTimeout(context.confirmTimer());
    context.setPendingConfirm(confirmation);
    context.setConfirmTimer(setTimeout(() => context.setPendingConfirm(null), 3000));
    return;
  }
  clearTimeout(context.confirmTimer());
  context.setPendingConfirm(null);
  if (action === 'cancel') {
    await gateway.request<RunCancelResult>(Methods.RUN_CANCEL, {
      runId: run.id,
      reason: 'Cancelled by operator from run details.',
    });
    return;
  }
  await gateway.request(Methods.RUN_DELETE, { runId: run.id });
  context.navigateToRuns();
}

export async function rescueRunLinkage(
  runId: string,
  context: RescueLinkageContext,
): Promise<void> {
  if (context.actionsBlocked()) return;
  if (context.rescueInProgress()) return;
  context.setRescueInProgress(true);
  try {
    // findPRNumber retries up to 65s (0+5+15+45) plus 4 gh calls; default
    // 15s RPC timeout would abort before the gateway finishes. Allow 120s.
    const res = await gateway.request<RunRehydratePrNumberResult>(
      Methods.RUN_REHYDRATE_PR_NUMBER,
      { runId },
      120_000,
    );
    if (!res.ok) {
      alert(`PR rescue failed: ${res.reason}`);
    } else if (res.reason) {
      // Partial success: PR was linked but ci-watch replay was skipped
      // (reassigned slot, disabled, etc.). Surface the reason so operators
      // know CI monitoring did not resume.
      alert(`PR #${res.prNumber} linked, but CI watch did not resume: ${res.reason}`);
    }
  } catch (err) {
    alert(`PR rescue failed: ${(err as Error).message}`);
  } finally {
    context.setRescueInProgress(false);
  }
}

export interface InteractiveDevResolveContext {
  actionsBlocked: () => boolean;
  busyAction: () => string | null;
  setBusyAction: (action: string | null) => void;
}

export async function resolveInteractiveDevAction(
  run: Run,
  action: DevInteractiveCompletionAction,
  context: InteractiveDevResolveContext,
): Promise<void> {
  if (context.actionsBlocked() || context.busyAction()) return;
  let prRef: string | undefined;
  if (action === 'link-pr-and-ci-watch' || action === 'link-pr-and-pr-complete') {
    prRef = window.prompt('PR ref or URL')?.trim() || undefined;
    if (!prRef) return;
  }
  let reason: string | undefined;
  if (action === 'blocked' || action === 'failed' || action === 'abort') {
    reason = window.prompt('Reason')?.trim() || undefined;
    if (!reason && action !== 'abort') return;
  }
  context.setBusyAction(action);
  try {
    const res = await gateway.request<RunInteractiveDevResolveResult>(
      Methods.RUN_INTERACTIVE_DEV_RESOLVE,
      { runId: run.id, action, prRef, reason },
      120_000,
    );
    if (!res.ok) {
      alert(`Interactive dev action failed: ${res.reason}`);
    } else if (res.reason) {
      alert(res.reason);
    } else if (res.chainedRunId) {
      location.hash = `run/${res.chainedRunId}`;
    }
  } catch (err) {
    alert(`Interactive dev action failed: ${(err as Error).message}`);
  } finally {
    context.setBusyAction(null);
  }
}

export function confirmForceComplete(
  run: Pick<Run, 'id' | 'status'>,
  context: ConfirmTimerContext,
): void {
  if (context.actionsBlocked()) return;
  if (context.pendingConfirm() === 'force-complete') {
    clearTimeout(context.confirmTimer());
    context.setPendingConfirm(null);
    const params: { runId: string; prNumber?: number } = { runId: run.id };
    if (run.status === 'failed') {
      const entered = window.prompt('PR number (optional, blank to skip)');
      if (entered == null) return;
      const raw = entered.trim();
      if (raw) {
        const prNumber = Number(raw);
        if (!Number.isInteger(prNumber) || prNumber <= 0) {
          alert('PR number must be a positive integer');
          return;
        }
        params.prNumber = prNumber;
      }
    }
    gateway
      .request<RunForceCompleteResult>(Methods.RUN_FORCE_COMPLETE, params)
      .then((result) => {
        const failed = failedRunCancelEffects(result.effects);
        if (failed.length) {
          alert(
            `Run marked done, but part of the teardown failed:\n${failed
              .map((effect) => `${effect.name}: ${effect.detail ?? 'failed'}`)
              .join('\n')}`,
          );
        }
      })
      .catch((err) => {
        alert(`Failed to force-complete run: ${(err as Error).message}`);
      });
  } else {
    clearTimeout(context.confirmTimer());
    context.setPendingConfirm('force-complete');
    context.setConfirmTimer(
      setTimeout(() => {
        context.setPendingConfirm(null);
      }, 3000),
    );
  }
}

export interface ConfirmDecisionContext extends ConfirmTimerContext {
  jumpToSuccessorWhenAvailable: (originRunId: string) => void;
}

export interface InteractiveHandoffSignalContext {
  actionsBlocked: () => boolean;
  busy: () => boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
}

export async function checkInteractiveHandoffSignal(
  runId: string,
  decision: RunDecision,
  context: InteractiveHandoffSignalContext,
): Promise<void> {
  if (context.actionsBlocked() || context.busy()) return;
  context.setBusy(true);
  context.setError(null);
  try {
    const probe = await gateway.request<RunProbeWorkerSignalResult>(
      Methods.RUN_PROBE_WORKER_SIGNAL,
      { runId },
    );
    if (!probe.ok) {
      context.setError(probe.message);
      return;
    }
    await gateway.request(
      Methods.RUN_RESOLVE_DECISION,
      buildRunResolveDecisionParams({
        runId,
        decision,
        actionId: 'signal-written',
      }),
    );
  } catch (err) {
    context.setError((err as Error).message);
  } finally {
    context.setBusy(false);
  }
}

export function confirmRunDecision(
  runId: string,
  decision: RunDecision,
  actionId: string,
  context: ConfirmDecisionContext,
): void {
  if (context.actionsBlocked()) return;
  // Danger actions require double-click confirmation, others resolve immediately
  const isDanger =
    actionId === 'abort' || (actionId === 'rework' && decision.type !== 'retrospective');
  if (!isDanger || context.pendingConfirm() === actionId) {
    clearTimeout(context.confirmTimer());
    context.setPendingConfirm(null);
    gateway
      .request(
        Methods.RUN_RESOLVE_DECISION,
        buildRunResolveDecisionParams({ runId, decision, actionId }),
      )
      .then(() => {
        // start-comparison cancels the current run and creates a successor in the comparison
        // lane. Without an auto-jump the operator stays on the now-cancelled origin and the
        // page looks stale — the only hint is the redirectedToRunId banner. Watch for the
        // successor link to land in state and navigate to it once.
        if (actionId === 'start-comparison') {
          context.jumpToSuccessorWhenAvailable(runId);
        }
      })
      .catch((err) => {
        // Keep the decision unresolved in place; the gateway remains the source of truth.
        console.error('Failed to resolve decision:', err);
      });
  } else {
    clearTimeout(context.confirmTimer());
    context.setPendingConfirm(actionId);
    context.setConfirmTimer(
      setTimeout(() => {
        context.setPendingConfirm(null);
      }, 3000),
    );
  }
}

export interface SuccessorJumpContext {
  jumpTimer: () => Timer;
  setJumpTimer: (timer: Timer) => void;
  isConnected: () => boolean;
  allRuns: () => Run[];
  navigateToRun: (runId: string) => void;
}

export function jumpToSuccessorWhenAvailable(
  originRunId: string,
  context: SuccessorJumpContext,
): void {
  if (context.jumpTimer()) clearTimeout(context.jumpTimer());
  const start = Date.now();
  const tryJump = () => {
    context.setJumpTimer(undefined);
    // Bail if the operator navigated away — don't yank them off the new page.
    if (!context.isConnected()) return;
    const origin = context.allRuns().find((run) => run.id === originRunId);
    if (origin?.redirectedToRunId) {
      context.navigateToRun(origin.redirectedToRunId);
      return;
    }
    if (Date.now() - start > 4000) return;
    context.setJumpTimer(setTimeout(tryJump, 200));
  };
  context.setJumpTimer(setTimeout(tryJump, 200));
}

export interface SlotDecisionContext {
  actionsBlocked: () => boolean;
  selectedSlotId: () => string | null;
  resetBranch: () => boolean;
  setSelectedSlotId: (slotId: string | null) => void;
  setResetBranch: (resetBranch: boolean) => void;
  setBranchNudgeShowPicker: (show: boolean) => void;
}

export function resolveBranchNudgePick(
  runId: string,
  decisionId: string,
  context: SlotDecisionContext,
): void {
  if (context.actionsBlocked()) return;
  const slotId = context.selectedSlotId();
  if (!slotId) return;
  gateway
    .request(
      Methods.RUN_RESOLVE_DECISION,
      buildRunResolveDecisionParams({
        runId,
        decision: { id: decisionId },
        actionId: 'pick',
        selectionData: { slotId },
      }),
    )
    .then(() => {
      context.setBranchNudgeShowPicker(false);
      context.setSelectedSlotId(null);
    })
    .catch((err) => {
      // Keep the picker state intact so the operator can retry or choose another action.
      console.error('Failed to resolve branch-nudge pick:', err);
    });
}

export function resolveSlotPick(
  runId: string,
  decisionId: string,
  context: SlotDecisionContext,
): void {
  if (context.actionsBlocked()) return;
  const slotId = context.selectedSlotId();
  if (!slotId) return;
  gateway
    .request(
      Methods.RUN_RESOLVE_DECISION,
      buildRunResolveDecisionParams({
        runId,
        decision: { id: decisionId },
        actionId: 'pick',
        selectionData: { slotId, resetBranch: context.resetBranch() },
      }),
    )
    .catch((err) => {
      // The gateway keeps the slot-pick decision pending; log the failure for diagnostics.
      console.error('Failed to resolve slot pick:', err);
    });
  context.setSelectedSlotId(null);
  context.setResetBranch(false);
}

/**
 * Warm-switch a slot onto this run's branch and bind the run to it, then open
 * slot-view. Uses strict slot.prepare (default attach profile; bind-only when
 * slotBranch already matches — no update-branch, no silent profile escalation).
 *
 * This is the only run→slot binding the UI exposes ("Load slot with run"): it
 * does NOT re-drive the run pipeline, so the run record is left intact and the
 * recipe-replay button in slot-view becomes available because the slot is bound
 * to this run. The heavier `run.activateOnSlot` RPC (which resets PREPARE→DISPATCH
 * and relaunches the worker) is intentionally not surfaced as a button — it
 * destroys gate state and is an operator escape hatch reachable via RPC/CLI only
 * (see ADR-024 Activate-on-Slot addendum).
 */
export interface SwitchSlotToRunBranchOptions {
  /** Named prepare profile (default: attach). */
  prepareProfile?: string;
  /** Slot's current branch — enables bind-only when it already matches the run. */
  slotBranch?: string | null;
  /** Fail fast when profile preconditions fail (default: true). */
  strictProfile?: boolean;
  /** Run full checkout even when the slot is already on the run branch. */
  forcePrepare?: boolean;
}

export async function switchSlotToRunBranch(
  runId: string,
  slotId: string,
  branch: string | null,
  // `rebind` lets the slot-side run loader take over a slot currently bound to a
  // different (idle) run. The run-detail button targets the run's own slot, so
  // it leaves this false.
  rebind = false,
  options: SwitchSlotToRunBranchOptions = {},
): Promise<void> {
  if (!slotId || !branch) {
    throw new Error(
      `Cannot switch ${slotId || '(no slot)'}: run ${runId.slice(0, 8)} has no branch`,
    );
  }
  // Throws on failure — callers surface it in-context (inline in the run loader,
  // a guarded catch on the run-detail button) rather than a browser alert.
  await runSlotPrepareForRun({
    slotId,
    runId,
    branch,
    slotBranch: options.slotBranch,
    prepareProfile: options.prepareProfile,
    strictProfile: options.strictProfile,
    forcePrepare: options.forcePrepare,
    rebind,
  });
  navigateToPreparedSlot(slotId, runId);
}
