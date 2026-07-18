import { Events, type Run, type RunCreateParams, type RunStatus } from '@farmslot/protocol';

import { monitorCI } from '../ci-monitor/service.js';
import { getProjectField, getProjectFieldRaw } from '../core/config.js';
import { markSlotHeld, updateSlotStatus } from '../core/index.js';
import { findPRNumber, persistRunPrNumber } from '../integrations/pr-linkage.js';
import { slotRelease } from '../methods/slot.js';
import {
  createRetrospectiveForRun,
  isArtifactOnlyRun,
  isPublishedStatus,
  publicationStatusForRun,
} from '../run-completion/orchestrator.js';
import { createRun, getRun, updateRun } from '../runs/store.js';
import { isNoCodeTerminalDisposition } from '../tasks/worker-signals.js';

import { captureReviewInputArtifactsForRun } from './diff-artifacts.js';
import { ciRequiresPublishedPr } from './publication-policy.js';

interface StepIO {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

type BroadcastFn = (event: string, payload: unknown) => void;
type LoadedProjectVars = { projectJson: Parameters<typeof getProjectField>[0] };
type CIOutcome = Awaited<ReturnType<typeof monitorCI>>;

interface CIWatchChainSpec {
  flowType: Run['flowType'];
  createParams: RunCreateParams;
  engineFlags: { skipPrepare?: true; warmRecovery?: true };
  updateFields: Partial<Run>;
}

export interface CIWatchStepContext {
  activeMonitors: Map<string, AbortController>;
  applyChainedRunEngineFlags: (
    runId: string,
    flags: { skipPrepare?: true; warmRecovery?: true },
  ) => void;
  broadcastFn: BroadcastFn;
  buildCIWatchChainedRunParams: (
    current: Run,
    dispatchAction: string | null | undefined,
    ciRepo: string,
  ) => CIWatchChainSpec | null;
  hasValidPrNumber: (run: Run) => boolean;
  loadProjectVarsOrNull: (
    project: string,
    context: string,
    runId?: string,
  ) => Promise<LoadedProjectVars | null>;
  resolveCIWatchTerminalPatch: (
    outcome?: CIOutcome,
  ) => { status?: RunStatus; metrics?: Partial<Run['metrics']> } | null;
  startRun: (runId: string) => Promise<void>;
}

export async function executeCIWatchStep(
  runId: string,
  context: CIWatchStepContext,
): Promise<StepIO> {
  const {
    activeMonitors,
    applyChainedRunEngineFlags,
    broadcastFn,
    buildCIWatchChainedRunParams,
    hasValidPrNumber,
    loadProjectVarsOrNull,
    resolveCIWatchTerminalPatch,
    startRun,
  } = context;
  const current = getRun(runId)!;
  if (!current.slotId) throw new Error('No slot assigned');
  const artifactOnly = isArtifactOnlyRun(current);
  if (isNoCodeTerminalDisposition(current.metrics.disposition)) {
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — skipping ci-watch for no-code disposition ${current.metrics.disposition}`,
    );
    try {
      const noopEmit = () => {};
      await slotRelease(
        {
          slotId: current.slotId,
          keepWork: true,
          keepWarm: true,
          detachRuns: false,
          expectedRunId: current.id,
        },
        noopEmit,
      );
    } catch (err) {
      console.warn(
        `[run-engine] slot release after no-code ci-watch skip failed: ${(err as Error).message}`,
      );
    }
    return {
      inputs: { prNumber: current.prNumber, disposition: current.metrics.disposition },
      outputs: {
        skipped: true,
        reason: 'no-code-terminal-disposition',
        disposition: current.metrics.disposition,
        phase: 'done',
        fixInProgress: false,
        fixTrigger: null,
        activeTaskFile: null,
        pollCount: 0,
        totalDurationMs: 0,
        checkTimeline: [],
        actionableBotCommentCount: 0,
      },
    };
  }
  if (artifactOnly) {
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — skipping ci-watch for artifact-only completion policy`,
    );
    try {
      const noopEmit = () => {};
      await slotRelease(
        {
          slotId: current.slotId,
          keepWork: true,
          keepWarm: true,
          detachRuns: false,
          expectedRunId: current.id,
        },
        noopEmit,
      );
    } catch (err) {
      console.warn(
        `[run-engine] slot release after artifact-only ci-watch skip failed: ${(err as Error).message}`,
      );
    }
    return {
      inputs: { prNumber: current.prNumber, completionPolicy: current.completionPolicy },
      outputs: {
        skipped: true,
        reason: 'artifact-only-policy',
        completionPolicy: current.completionPolicy,
        phase: 'done',
        fixInProgress: false,
        fixTrigger: null,
        activeTaskFile: null,
        pollCount: 0,
        totalDurationMs: 0,
        checkTimeline: [],
        actionableBotCommentCount: 0,
      },
    };
  }
  if (ciRequiresPublishedPr(current) && !isPublishedStatus(publicationStatusForRun(current))) {
    console.warn(
      `[run-engine] run ${runId.slice(0, 8)} — skipping ci-watch before approved publication (${publicationStatusForRun(current)})`,
    );
    try {
      const noopEmit = () => {};
      await slotRelease(
        {
          slotId: current.slotId,
          keepWork: true,
          keepWarm: true,
          detachRuns: false,
          expectedRunId: current.id,
        },
        noopEmit,
      );
    } catch (err) {
      console.warn(
        `[run-engine] slot release after unpublished ci-watch skip failed: ${(err as Error).message}`,
      );
    }
    return {
      inputs: {
        prNumber: current.prNumber,
        publicationStatus: publicationStatusForRun(current),
      },
      outputs: {
        skipped: true,
        reason: 'not_published_local_first',
        publicationStatus: publicationStatusForRun(current),
        phase: 'done',
        fixInProgress: false,
        fixTrigger: null,
        activeTaskFile: null,
        pollCount: 0,
        totalDurationMs: 0,
        checkTimeline: [],
        actionableBotCommentCount: 0,
      },
    };
  }
  await markSlotHeld(current.slotId, 'ci-watch');

  const pv = await loadProjectVarsOrNull(current.project, 'run step', current.id);
  const ciRepo = pv ? getProjectField(pv.projectJson, 'ci.repo') : '';
  const ciEnabled = pv ? getProjectFieldRaw(pv.projectJson, 'ci.enabled') : undefined;
  if (ciEnabled === false) {
    console.log(`[run-engine] run ${runId.slice(0, 8)} — ci disabled, skipping ci-watch`);
    try {
      const noopEmit = () => {};
      await slotRelease(
        {
          slotId: current.slotId,
          keepWork: true,
          keepWarm: true,
          detachRuns: false,
          expectedRunId: current.id,
        },
        noopEmit,
      );
    } catch (err) {
      console.warn(
        `[run-engine] slot release after disabled ci-watch skip failed: ${(err as Error).message}`,
      );
    }
    return {
      inputs: { prNumber: current.prNumber, ciRepo, enabled: false },
      outputs: {
        skipped: true,
        reason: 'ci-disabled',
        phase: 'done',
        fixInProgress: false,
        fixTrigger: null,
        activeTaskFile: null,
        pollCount: 0,
        totalDurationMs: 0,
        checkTimeline: [],
        actionableBotCommentCount: 0,
      },
    };
  }

  // Eager linkage: if completion-time findPRNumber missed (silent-catch or CLABot race),
  // retry once here with the hardened retry path before giving up. Local-first runs
  // may only resolve PRs after approved publication; mirror the CI publication gate here
  // so future reordering cannot bypass the human package approval invariant.
  const canRescuePrNumber =
    !ciRequiresPublishedPr(current) || isPublishedStatus(publicationStatusForRun(current));
  if (!current.prNumber && ciRepo && canRescuePrNumber) {
    const rescued = await findPRNumber(current, ciRepo);
    if (rescued) {
      await persistRunPrNumber(runId, rescued);
      current.prNumber = rescued;
      await captureReviewInputArtifactsForRun(getRun(runId)!);
    }
  }

  const inputs: Record<string, unknown> = { prNumber: current.prNumber };
  if (!current.prNumber) {
    console.warn(`[run-engine] run ${runId.slice(0, 8)} — no PR number, skipping ci-watch`);
    try {
      const noopEmit = () => {};
      await slotRelease(
        {
          slotId: current.slotId,
          keepWork: true,
          keepWarm: true,
          detachRuns: false,
          expectedRunId: current.id,
        },
        noopEmit,
      );
    } catch (err) {
      console.warn(
        `[run-engine] slot release after no-pr ci-watch skip failed: ${(err as Error).message}`,
      );
    }
    return {
      inputs,
      outputs: {
        skipped: true,
        reason: 'no PR number',
        phase: 'done',
        fixInProgress: false,
        fixTrigger: null,
        activeTaskFile: null,
        pollCount: 0,
        totalDurationMs: 0,
        checkTimeline: [],
        actionableBotCommentCount: 0,
      },
    };
  }

  if (!ciRepo) {
    console.warn(
      `[run-engine] run ${runId.slice(0, 8)} — no ci.repo configured, skipping ci-watch`,
    );
    return {
      inputs,
      outputs: {
        skipped: true,
        reason: 'no ci.repo configured',
        phase: 'done',
        fixInProgress: false,
        fixTrigger: null,
        activeTaskFile: null,
        pollCount: 0,
        totalDurationMs: 0,
        checkTimeline: [],
        actionableBotCommentCount: 0,
      },
    };
  }

  // Check if a previous CI decision already requested chaining (e.g. after gateway restart)
  const resolvedChainDecision = current.decisions.find(
    (d) =>
      d.resolvedAt &&
      (d.resolvedAction === 'dispatch-update-branch' ||
        d.resolvedAction === 'dispatch-pr-complete'),
  );
  if (resolvedChainDecision) {
    const chainAction = resolvedChainDecision.resolvedAction!;
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — found resolved chain decision: ${chainAction}, skipping CI monitor`,
    );
    const syntheticOutcome: Awaited<ReturnType<typeof monitorCI>> = {
      result: 'failed',
      failedChecks: ['MERGE_CONFLICT'],
      pollCount: 0,
      phase: 'done',
      fixInProgress: false,
      fixTrigger: null,
      activeTaskFile: null,
      totalDurationMs: 0,
      checkTimeline: [],
      actionableBotCommentCount: 0,
      dispatchAction: chainAction,
    };
    // Jump straight to chaining logic below
    const chainSpec = buildCIWatchChainedRunParams(current, chainAction, ciRepo);
    if (!chainSpec) {
      return { inputs, outputs: { ...syntheticOutcome } };
    }
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — chaining ${chainSpec.flowType} on slot ${current.slotId} ticket=${chainSpec.createParams.ticketOrPr}`,
    );
    const chainRun = createRun(chainSpec.createParams);
    applyChainedRunEngineFlags(chainRun.id, chainSpec.engineFlags);
    if (Object.keys(chainSpec.updateFields).length) updateRun(chainRun.id, chainSpec.updateFields);
    broadcastFn(Events.RUN_UPDATED, { run: getRun(chainRun.id) ?? chainRun });
    // Clear agent status so chained run's find-slot can pick up this slot
    await updateSlotStatus(current.slotId, { agent: 'idle' });
    startRun(chainRun.id).catch((err) => {
      console.error(
        `[run-engine] chained ${chainSpec.flowType} run failed: ${(err as Error).message}`,
      );
    });
    return { inputs, outputs: { ...syntheticOutcome, chainedRunId: chainRun.id } };
  }

  const controller = new AbortController();
  activeMonitors.set(runId, controller);
  let outcome: Awaited<ReturnType<typeof monitorCI>> | undefined;
  try {
    outcome = await monitorCI(runId, current.prNumber, ciRepo, controller.signal);

    console.log(`[run-engine] run ${runId.slice(0, 8)} — CI outcome: ${outcome.result}`);

    const ciPatch = resolveCIWatchTerminalPatch(outcome);
    if (ciPatch) {
      updateRun(runId, {
        ...(ciPatch.status ? { status: ciPatch.status } : {}),
        metrics: {
          ...current.metrics,
          ...(ciPatch.metrics ?? {}),
        },
      });
    }
  } finally {
    activeMonitors.delete(runId);
  }

  let chainedRunId: string | undefined;
  const chainSpec = buildCIWatchChainedRunParams(current, outcome?.dispatchAction, ciRepo);
  if (chainSpec) {
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — chaining ${chainSpec.flowType} on slot ${current.slotId} ticket=${chainSpec.createParams.ticketOrPr}`,
    );
    const chainRun = createRun(chainSpec.createParams);
    applyChainedRunEngineFlags(chainRun.id, chainSpec.engineFlags);
    if (Object.keys(chainSpec.updateFields).length) updateRun(chainRun.id, chainSpec.updateFields);
    broadcastFn(Events.RUN_UPDATED, { run: getRun(chainRun.id) ?? chainRun });
    chainedRunId = chainRun.id;
    // Clear agent status so chained run's find-slot can pick up this slot
    await updateSlotStatus(current.slotId, { agent: 'idle' });
    // Start the chained run (don't await — let it run independently)
    startRun(chainRun.id).catch((err) => {
      console.error(
        `[run-engine] chained ${chainSpec.flowType} run failed: ${(err as Error).message}`,
      );
    });
  } else {
    // No chaining means this CI-watch run is the terminal PR lifecycle step.
    // Create the family-level retrospective here even when the flow had a
    // human-gate; the gate approved publication but did not capture CI,
    // review-comment follow-ups, update-branch friction, or final PR outcome.
    await createRetrospectiveForRun(runId);
    // Release slot
    try {
      const noopEmit = () => {};
      await slotRelease(
        {
          slotId: current.slotId,
          keepWork: true,
          keepWarm: true,
          detachRuns: false,
          expectedRunId: current.id,
        },
        noopEmit,
      );
    } catch (err) {
      console.warn(`[run-engine] slot release after ci-watch failed: ${(err as Error).message}`);
    }
  }

  const ciWatchCliCommand =
    ciRepo && hasValidPrNumber(current)
      ? `farmslot pr status ${current.prNumber} --repo ${ciRepo}`
      : undefined;
  return {
    inputs,
    outputs: {
      result: outcome?.result ?? 'unknown',
      failedChecks: outcome?.failedChecks ?? [],
      phase: outcome?.phase ?? 'done',
      fixInProgress: outcome?.fixInProgress ?? false,
      fixTrigger: outcome?.fixTrigger ?? null,
      activeTaskFile: outcome?.activeTaskFile ?? null,
      nextPollAt: outcome?.nextPollAt ?? null,
      lastSignalAt: outcome?.lastSignalAt ?? null,
      dedupReason: outcome?.dedupReason ?? null,
      lastFixCommitSha: outcome?.lastFixCommitSha ?? null,
      fixProgress: outcome?.fixProgress,
      pollCount: outcome?.pollCount ?? 0,
      pollIntervalMs: outcome?.pollIntervalMs,
      lastCheckedAt: outcome?.lastCheckedAt,
      totalDurationMs: outcome?.totalDurationMs ?? 0,
      checkTimeline: outcome?.checkTimeline ?? [],
      actionableBotCommentCount: outcome?.actionableBotCommentCount ?? 0,
      inlineFixAttempts: outcome?.inlineFixAttempts ?? 0,
      inlineFixTotalAttempts: outcome?.inlineFixTotalAttempts ?? 0,
      chainedRunId,
      cliCommand: ciWatchCliCommand,
    },
  };
}
