import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  Events,
  PipelineSteps,
  type PublicationTarget,
  type ReadyGatePrPackage,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

import { farmslotRoot, getProjectField, loadSlotVars } from '../core/config.js';
import { execLocal, execOnSlot, isLocal } from '../core/exec.js';
import { markSlotHeld } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';
import { loadFleetStatus } from '../fleet/state.js';
import { ghRequest } from '../integrations/github-client.js';
import { slotRelease } from '../methods/slot.js';
import {
  assertReadyGatePackageInputsCurrent,
  isArtifactOnlyRun,
  publicationStatusForRun,
  publishCompletionPackage,
} from '../run-completion/orchestrator.js';
import {
  verifyReadyGatePackageHash,
  verifyReadyGateSelectedEvidenceFiles,
} from '../run-completion/ready-gate-package.js';
import { resolveRunnerSessionForRun } from '../runners/session-process.js';
import { getRun, updateRun, updateRunStep } from '../runs/store.js';
import { parseSessionUsageOutput, usesReviewChainSessionTotal } from '../runtime/session-usage.js';
import { isNoCodeTerminalDisposition } from '../tasks/worker-signals.js';

import {
  assertPublicationReviewPolicySatisfied,
  CLOSE_AS_SHIPPED_ACTION,
  isPublishApprovalAction,
  validatePackageApprovalSelection,
} from './gate-policy.js';
import { requiresPublicationApproval } from './publication-policy.js';
import { createSubStepCollector } from './sub-step-collector.js';

interface StepIO {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

type BroadcastFn = (event: string, payload: unknown) => void;
type LoadedProjectVars = { projectJson: Parameters<typeof getProjectField>[0] };

export interface FinalizeStepContext {
  blockedRunError: (message: string, reason: string) => Error;
  broadcastFn: BroadcastFn;
  latestResolvedHumanGateDecision: (
    decisions: RunDecision[],
    approvalOnly?: boolean,
  ) => RunDecision | undefined;
  loadProjectVarsOrNull: (
    project: string,
    context: string,
    runId?: string,
  ) => Promise<LoadedProjectVars | null>;
  readPreparedPackage: (current: Run) => Promise<ReadyGatePrPackage | undefined>;
  refreshRunLinks: (runId: string) => Promise<void>;
  stepPartialIO: Map<string, StepIO>;
}

const S = PipelineSteps;

export async function executeFinalizeStep(
  runId: string,
  context: FinalizeStepContext,
): Promise<StepIO> {
  const {
    blockedRunError,
    broadcastFn,
    latestResolvedHumanGateDecision,
    loadProjectVarsOrNull,
    readPreparedPackage,
    refreshRunLinks,
    stepPartialIO,
  } = context;
  const current = getRun(runId)!;
  if (!current.slotId) throw new Error('No slot assigned');
  const noCodeDisposition = isNoCodeTerminalDisposition(current.metrics.disposition);
  const artifactOnly = isArtifactOnlyRun(current);
  const publicationApprovalGate = requiresPublicationApproval(current);
  const inputs: Record<string, unknown> = {
    slotId: current.slotId,
    flowType: current.flowType,
    noCodeDisposition,
  };

  // Sub-step collector + emitter — gives UI per-phase feedback during what
  // would otherwise be a multi-minute "Finalizing…" with no progress signal.
  // Mirrors the write-task / prepare patterns; each substep updates
  // step.detail in place so the slot view reflects current activity.
  const collector = createSubStepCollector();
  const emitWithBroadcast = (event: string, payload: unknown) => {
    collector.emit(event, payload);
    const p = payload as { name?: string; detail?: string } | undefined;
    if (p?.name) {
      const outputs: Record<string, unknown> = { subSteps: collector.snapshot() };
      updateRunStep(runId, S.FINALIZE, { detail: p.detail || p.name, outputs });
      stepPartialIO.set(runId, { inputs, outputs });
      broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
    }
  };

  // 0. Capture session metrics while the gate-held worker may still be alive.
  emitWithBroadcast('substep', {
    name: 'session-metrics',
    detail: 'Reading worker session usage',
  });
  let session: Record<string, unknown> | undefined;
  try {
    const vars = await loadSlotVars(current.slotId);
    const runner = current.metrics.runner;
    const resolved = runner && current ? await resolveRunnerSessionForRun(current, vars) : null;
    let runnerSessionPath = resolved?.runnerSessionPath ?? current.metrics.runnerSessionPath;
    if (resolved && runnerSessionPath) {
      updateRun(runId, {
        metrics: {
          ...current.metrics,
          runnerSessionPath,
          runnerSessionId: resolved.runnerSessionId,
        },
      });
    }
    const usageEnv = runnerSessionPath
      ? `RUNNER_SESSION_PATH='${runnerSessionPath.replace(/'/g, `'\\''`)}' RUNNER_SESSION_RUNNER='${(runner ?? '').replace(/'/g, `'\\''`)}' `
      : '';
    const cmd = `${usageEnv}bash "${farmslotRoot}/scripts/session-usage.sh" '${current.slotId}' total 2>/dev/null`;
    const result = isLocal(vars.host, vars.machine)
      ? await execLocal(cmd, { timeout: 15000 })
      : await execLocal(`ssh ${vars.sshTarget} "${cmd}"`, { timeout: 15000 });
    if (result.stdout.trim()) {
      const metricsLines = result.stdout.trim().split('\n');
      session = Object.fromEntries(
        metricsLines.filter(Boolean).map((line) => {
          const [k, ...rest] = line.split('=');
          return [k, rest.join('=')];
        }),
      );
      const chainSessionTotal = usesReviewChainSessionTotal(current);
      if (chainSessionTotal) session.usage_scope = 'review-chain-total';
      const costRaw = session.cost_usd ?? session.costUsd;
      const cost = costRaw ? Number(costRaw) : current.metrics.costEstimate;
      const latestMetrics = getRun(runId)?.metrics ?? current.metrics;
      const usage = parseSessionUsageOutput(result.stdout, {
        runner,
        runnerSessionId: resolved?.runnerSessionId ?? latestMetrics.runnerSessionId,
        runnerSessionPath,
      });
      updateRun(runId, {
        metrics: chainSessionTotal
          ? {
              ...latestMetrics,
              sessionUsageScope: 'review-chain-total',
              reviewChainUsageTotal: usage,
            }
          : { ...latestMetrics, costEstimate: cost, sessionUsageScope: 'session-total' },
      });
    }
  } catch (err) {
    console.warn(
      `[run-engine] session metrics capture failed (non-fatal): ${(err as Error).message}`,
    );
  }

  // 1. Keep gate-held worker sessions warm through ci-watch so CI follow-ups
  // (inline fix, chained pr-complete / update-branch) can reuse the same
  // context. Tear down only on terminal failure (teardownGateHeldAgentsIfNeeded),
  // slotRelease when the family ends, or operator cancel — not at FINALIZE.
  if (publicationApprovalGate) {
    emitWithBroadcast('substep', {
      name: 'agent-keep-warm',
      detail: 'Keeping worker session warm through ci-watch',
    });
  }

  // 2. Restore slot lifecycle — may be stuck in 'review-gate' if gateway crashed mid human-gate
  emitWithBroadcast('substep', {
    name: 'slot-lifecycle',
    detail: noCodeDisposition ? 'Releasing slot (no-code)' : 'Holding slot for ci-watch',
  });
  try {
    if (noCodeDisposition) {
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
    } else {
      await markSlotHeld(current.slotId, 'ci-watch');
    }
    broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus(true) });
  } catch (err) {
    // Finalize continues so run completion is not lost, but slot lifecycle
    // drift is operator-actionable and must be logged.
    console.warn(
      `[run-engine] finalize slot hold failed for ${runId.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
    );
  }

  // 3. Save session metrics to task folder as artifact
  emitWithBroadcast('substep', {
    name: 'save-session-metrics',
    detail: 'Writing artifacts/session-metrics.json',
  });
  let metricsSavedToTask = false;
  if (current.taskFile) {
    try {
      const artifactsDir = path.join(path.dirname(current.taskFile), 'artifacts');
      await mkdir(artifactsDir, { recursive: true });
      const metricsData = {
        runId: current.id,
        flowType: current.flowType,
        project: current.project,
        slotId: current.slotId,
        model: current.metrics.model,
        runner: current.metrics.runner,
        costEstimate: current.metrics.costEstimate,
        totalDurationMs: Date.now() - new Date(current.createdAt).getTime(),
        nudgeCount: current.metrics.nudgeCount,
        session: session ?? null,
        capturedAt: new Date().toISOString(),
      };
      const metricsPath = path.join(artifactsDir, 'session-metrics.json');
      await writeFile(metricsPath, JSON.stringify(metricsData, null, 2));
      metricsSavedToTask = true;
      console.log(`[run-engine] session metrics saved to ${metricsPath}`);
    } catch (err) {
      console.warn(`[run-engine] metrics save failed (non-fatal): ${(err as Error).message}`);
    }
  }

  // 4. Publish approved local-first package for fix-bug. This is the
  // first point where public PR mutation is allowed.
  const pv = await loadProjectVarsOrNull(current.project, 'run step', current.id);
  const ciRepo = pv ? getProjectField(pv.projectJson, 'ci.repo') || null : null;
  const gateDecision = latestResolvedHumanGateDecision(current.decisions, publicationApprovalGate);
  const resolvedAction = gateDecision?.resolvedAction;
  let publicationStatus = publicationStatusForRun(current);
  let publicationTarget: PublicationTarget | undefined =
    current.engineState?.publishGate?.publicationTarget;
  let publishedPrNumber: number | null = current.prNumber ?? null;
  let publishPackageHash: string | undefined;
  let publishBodyPostProcessed = false;
  if (publicationApprovalGate && resolvedAction === CLOSE_AS_SHIPPED_ACTION) {
    // Work already merged out-of-band: link the merged PR and skip publication
    // entirely — package-hash/HEAD verification would rightly fail here, and
    // there is nothing left to publish.
    emitWithBroadcast('substep', {
      name: 'close-as-shipped',
      detail: 'Branch already merged — linking PR and skipping publication',
    });
    if (!publishedPrNumber && ciRepo) {
      const { findMergedPRNumber, persistRunPrNumber } =
        await import('../integrations/pr-linkage.js');
      publishedPrNumber = await findMergedPRNumber(current, ciRepo);
      if (publishedPrNumber) await persistRunPrNumber(current.id, publishedPrNumber);
    }
    if (publishedPrNumber) {
      // Only claim publication when a PR is actually linked; the zero-ahead
      // variant (no discoverable PR) completes without publication linkage.
      publicationStatus = 'published_ready';
      updateRun(runId, {
        engineState: {
          ...getRun(runId)!.engineState,
          publishGate: {
            ...getRun(runId)!.engineState?.publishGate,
            publicationStatus,
          },
        },
      });
    } else {
      emitWithBroadcast('substep', {
        name: 'close-as-shipped',
        detail: 'No PR link found — completing without publication linkage',
      });
    }
  } else if (publicationApprovalGate) {
    if (!isPublishApprovalAction(resolvedAction)) {
      throw blockedRunError(
        'Local-first publication requires approve-publish before finalize',
        resolvedAction ?? 'missing-approval',
      );
    }
    emitWithBroadcast('substep', {
      name: 'validate-approved-package',
      detail: 'Validating approved package + review policy',
    });
    const preparedPackage = await readPreparedPackage(current);
    if (!preparedPackage) throw new Error('Approved PR package snapshot missing');
    verifyReadyGatePackageHash(preparedPackage);
    validatePackageApprovalSelection(preparedPackage, gateDecision);
    assertPublicationReviewPolicySatisfied(current, preparedPackage);
    const approvedHash = current.engineState?.publishGate?.approvedPackageHash;
    if (approvedHash && approvedHash !== preparedPackage.packageHash) {
      throw new Error(
        `Package changed; refresh package and re-review before publishing (approved hash ${approvedHash} but package is ${preparedPackage.packageHash})`,
      );
    }
    if (!preparedPackage.headSha || !current.slotId) {
      throw new Error('Approved PR package must be linked to a slot HEAD SHA');
    }
    emitWithBroadcast('substep', {
      name: 'verify-head',
      detail: `Verifying slot HEAD matches approved ${preparedPackage.headSha.slice(0, 8)}`,
    });
    const vars = await loadSlotVars(current.slotId);
    const head = (
      await execOnSlot(vars, `git -C ${shellQuote(vars.remoteRepo)} rev-parse HEAD 2>/dev/null`, {
        timeout: 15_000,
      })
    ).stdout.trim();
    if (!head || head !== preparedPackage.headSha) {
      throw new Error(
        `Package changed; refresh package and re-review before publishing (approved HEAD ${preparedPackage.headSha.slice(0, 12)} but live HEAD is ${head ? head.slice(0, 12) : 'unknown'})`,
      );
    }
    const selection = gateDecision?.selectionData ?? {};
    const selectedTarget: PublicationTarget =
      selection.publicationTarget === 'ready'
        ? 'ready'
        : selection.publicationTarget === 'draft'
          ? 'draft'
          : preparedPackage.publicationTarget;
    const selectedEvidenceKeys = preparedPackage.selectedEvidenceKeys;
    await verifyReadyGateSelectedEvidenceFiles(
      current,
      preparedPackage,
      selectedEvidenceKeys ?? [],
    );
    await assertReadyGatePackageInputsCurrent(current, preparedPackage);
    const approvedPackage: ReadyGatePrPackage = {
      ...preparedPackage,
      publicationTarget: selectedTarget,
      approvedAt: current.engineState?.publishGate?.approvedAt ?? new Date().toISOString(),
    };
    emitWithBroadcast('substep', {
      name: 'publish-package',
      detail: `Publishing package to ${selectedTarget}`,
    });
    const published = await publishCompletionPackage(runId, approvedPackage, {
      publicationTarget: selectedTarget,
      comment: typeof selection.comment === 'string' ? selection.comment : undefined,
      selectedEvidenceKeys,
      emit: emitWithBroadcast,
    });
    publicationStatus = published.publicationStatus;
    publicationTarget = selectedTarget;
    publishedPrNumber = published.prNumber;
    publishPackageHash = published.packageHash;
    publishBodyPostProcessed = published.bodyPostProcessed;
    emitWithBroadcast('substep', { name: 'refresh-links', detail: 'Refreshing PR run links' });
    await refreshRunLinks(runId);
  }

  // 5. Post reviewer comment if provided for legacy ready gates. Local-first
  // publication comments are handled inside publishCompletionPackage so they
  // cannot occur before approval and do not duplicate after publication.
  const prNumber = publicationApprovalGate ? publishedPrNumber : current.prNumber;
  let commentPosted = false;
  const comment = gateDecision?.selectionData?.comment as string | undefined;
  if (!artifactOnly && !publicationApprovalGate && comment && ciRepo && prNumber) {
    emitWithBroadcast('substep', {
      name: 'post-legacy-comment',
      detail: `Posting reviewer comment to PR #${prNumber}`,
    });
    try {
      await ghRequest(['pr', 'comment', String(prNumber), '--repo', ciRepo, '--body', comment], {
        force: true,
      });
      commentPosted = true;
    } catch (err) {
      console.warn(`[run-engine] comment post failed: ${(err as Error).message}`);
    }
  }

  const cliCommand = `farmslot slot release ${current.slotId}`;
  return {
    inputs,
    outputs: {
      session: session ?? null,
      commentPosted,
      metricsSavedToTask,
      artifactPath: metricsSavedToTask ? 'artifacts/session-metrics.json' : undefined,
      costEstimate: current.metrics.costEstimate,
      model: current.metrics.model,
      runner: current.metrics.runner,
      cliCommand,
      publicationStatus,
      publicationTarget,
      publishedPrNumber,
      packageHash: publishPackageHash,
      bodyPostProcessed: publishBodyPostProcessed,
      subSteps: collector.finish(),
    },
  };
}
