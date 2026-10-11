import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type DecisionAction,
  isTerminalRunStatus,
  type NoChangeGatePayload,
  qualifyingPassingReviews,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  type RecipeValidationResult,
  type ReviewGatePayload,
  type ReviewStatus,
  type Run,
  type RunDecision,
  type RunDecisionPayload,
  type RunGatePrerequisiteReason,
  type RunGateReadiness,
} from '@farmslot/protocol';

import { selectAgentContext } from '../agents/contexts.js';
import { loadSlotVars, resolveRemoteRepo } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { shellQuote } from '../core/tmux.js';
import { parseStructuredReviewFeedback } from '../review/feedback.js';
import { readReviewWorkspaceCompletion } from '../review-workspaces/task.js';
import { verifyReadyGateSelectedEvidenceFiles } from '../run-completion/ready-gate-package.js';
import {
  readRunProgress,
  runDecisionWaitingStatus,
  type RunProgressObservation,
} from '../runners/run-progress.js';
import { getRun, updateRun } from '../runs/store.js';
import {
  type AcceptanceStatusRead,
  readAcceptanceStatusForDisplay,
} from '../tasks/acceptance-status.js';
import { resolveContextFilePath } from '../tasks/watcher.js';
import {
  loadTerminalContractForRun,
  validateDeterministicChecksForRun,
} from '../tasks/worker-terminal-contract.js';

import { readReviewInputSnapshot } from './diff-artifacts.js';
import {
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  assertPublicationReviewPolicySatisfied,
  isPublishApprovalAction,
} from './gate-policy.js';
import {
  readReviewArtifacts,
  reviewCommitFromMarkdown,
  reviewRecommendationFromMarkdown,
} from './review-artifacts.js';
import { runSupersededSince } from './run-generation.js';
import { readTaskArtifactText } from './task-artifacts.js';

export interface GatePrerequisiteReaders {
  deterministic(run: Run): Promise<unknown>;
  acceptance(run: Run): Promise<GateAcceptanceRead>;
  progress(run: Run): Promise<RunProgressObservation>;
  /** The ADR-062 producer supplies its canonical validation result. */
  recordedEvidence?: (
    run: Run,
    preparedPackage: ReadyGatePrPackage | null,
  ) => Promise<RecipeValidationResult>;
  reviewResult(run: Run, relativePath: string): Promise<string | undefined>;
  selectedEvidence(run: Run, preparedPackage: ReadyGatePrPackage): Promise<void>;
  reviewDocument(run: Run): Promise<boolean>;
}

export interface GateAcceptanceRead extends AcceptanceStatusRead {
  /** Refusals from the existing completion guard, never a display-count verdict. */
  issues: readonly string[];
}

const require = createRequire(import.meta.url);
const { acceptanceContractIssues } =
  require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs') as {
    acceptanceContractIssues(taskDir: string, options: { allowWeak: boolean }): string[];
  };

export async function readGateAcceptance(
  run: Run,
  sources: { slot: typeof loadSlotVars; contract: typeof loadTerminalContractForRun } = {
    slot: loadSlotVars,
    contract: loadTerminalContractForRun,
  },
): Promise<GateAcceptanceRead> {
  const expected = run.ticketData?.acceptanceCriteria?.filter((text) => text.trim()) ?? [];
  if (!run.taskFile)
    return {
      criteria: [],
      ledger: null,
      issues: [],
      error: 'Task registration is missing',
    };
  try {
    if (run.reviewWorkspace) {
      // Workspace review completion already validates its frozen task, result,
      // report and completion guard through the owning review implementation.
      const result = run.reviewWorkspace.cleanedAt
        ? run.reviewResult
        : (await readReviewWorkspaceCompletion(run.id))?.result;
      return {
        criteria: [],
        ledger: null,
        issues: [],
        ...(!result ? { error: 'Workspace review completion is unavailable' } : {}),
      };
    }
    // The dispatched primary task is the authority. The retained orchestrator copy
    // can lag behind a fix or lose registration; neither can approve current work.
    if (!run.slotId) throw new Error('Task checkout is unavailable');
    const vars = await sources.slot(run.slotId);
    const primary = selectAgentContext(run, { role: 'primary' });
    if (!primary?.taskFile) throw new Error('Primary task binding is missing');
    const taskFile = resolveContextFilePath(vars.remoteRepo, primary.taskFile, '');
    const taskDir = path.posix.dirname(taskFile);
    const acceptance = await readAcceptanceStatusForDisplay(vars, taskDir);
    if (acceptance.error) return { ...acceptance, issues: [] };
    if (
      expected.length &&
      (acceptance.criteria.length !== expected.length ||
        expected.some((text, index) => acceptance.criteria[index]?.text.trim() !== text.trim()))
    )
      return {
        ...acceptance,
        issues: [],
        error: 'Original acceptance registration is missing or changed',
      };
    if (!acceptance.criteria.length) return { ...acceptance, issues: [] };
    const contract = await sources.contract(run, run.slotId);
    const options = { allowWeak: contract.acceptance?.allowWeak === true };
    if (isLocal(vars.host, vars.machine))
      return { ...acceptance, issues: acceptanceContractIssues(taskDir, options) };
    const agentRoot = resolveRemoteRepo('~/farmslot-node', vars.osType, vars.sshUser);
    const guard = `${agentRoot}/packages/agent-runtime/scripts/acceptance-ledger.cjs`;
    const script =
      'const { acceptanceContractIssues } = require(process.argv[1]); process.stdout.write(JSON.stringify(acceptanceContractIssues(process.argv[2], JSON.parse(process.argv[3]))));';
    const result = await execOnSlot(
      vars,
      `node -e ${shellQuote(script)} ${shellQuote(guard)} ${shellQuote(taskDir)} ${shellQuote(JSON.stringify(options))}`,
      { timeout: 15_000 },
    );
    if (result.exitCode !== 0) throw new Error('Acceptance guard is unavailable on the task node');
    const issues: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(issues) || issues.some((issue) => typeof issue !== 'string'))
      throw new Error('Acceptance guard returned an invalid result');
    return { ...acceptance, issues: issues as string[] };
  } catch (error) {
    // Unreadable authority is an explicit refusal; it never erases the task's ACs.
    return {
      criteria: [],
      ledger: null,
      issues: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const readers: GatePrerequisiteReaders = {
  deterministic: validateDeterministicChecksForRun,
  acceptance: readGateAcceptance,
  progress: readRunProgress,
  reviewDocument: async (run) => {
    if (run.reviewWorkspace)
      return Boolean(
        run.reviewWorkspace.cleanedAt
          ? run.reviewResult
          : (await readReviewWorkspaceCompletion(run.id))?.result,
      );
    const [review, input] = await Promise.all([
      readReviewArtifacts(run.id),
      readReviewInputSnapshot(run.taskFile),
    ]);
    const snapshot = input.snapshot;
    return (
      review.hasReview &&
      Boolean(snapshot?.headSha) &&
      snapshot?.source !== 'unavailable' &&
      reviewCommitFromMarkdown(review.reviewMd) === snapshot?.headSha &&
      reviewRecommendationFromMarkdown(review.reviewMd) !== null
    );
  },
  reviewResult: (run, relativePath) =>
    readTaskArtifactText(run.taskFile, relativePath.slice('artifacts/'.length)),
  selectedEvidence: (run, preparedPackage) =>
    verifyReadyGateSelectedEvidenceFiles(
      run,
      preparedPackage,
      preparedPackage.selectedEvidenceKeys ?? [],
    ),
};

function resultArtifact(review: ReviewStatus): string | undefined {
  return (review.attempts?.at(-1)?.artifactPaths ?? review.artifactPaths)
    ?.slice()
    .reverse()
    .find(
      (entry) =>
        entry.startsWith('artifacts/') &&
        !entry.split('/').includes('..') &&
        path.posix.basename(entry) === 'review-result.json',
    );
}

/** Compose owner validators; absent validation is a refusal, never a success. */
export async function collectRunGateReadiness(
  run: Run,
  preparedPackage: ReadyGatePrPackage | null,
  overrides: Partial<GatePrerequisiteReaders> = {},
): Promise<RunGateReadiness> {
  const generation = run.engineState?.generation ?? 0;
  const source = { ...readers, ...overrides };
  const reasons: RunGatePrerequisiteReason[] = [];
  if (run.flowType === 'review-pr') {
    let valid = false;
    try {
      valid = await source.reviewDocument(run);
    } catch {
      // Invalid completion must remain inspectable with the refusal below.
      valid = false;
    }
    if (!valid)
      reasons.push({
        code: 'review-document-missing',
        prerequisite: 'review',
        message: 'The required reviewer result is missing or invalid.',
        actionId: 'dismiss',
      });
  }
  try {
    await source.deterministic(run);
  } catch {
    // The owner validator rejects absent/stale/failed receipts. Preserve that refusal.
    reasons.push({
      code: 'deterministic-not-passed',
      prerequisite: 'deterministic',
      message: 'A declared deterministic check has no current passing receipt.',
      actionId: 'hold',
    });
  }
  const acceptance = await source.acceptance(run);
  if (acceptance.error) {
    reasons.push({
      code: 'acceptance-unreadable',
      prerequisite: 'acceptance',
      message: 'The registered acceptance criteria or their verdicts could not be read.',
      actionId: 'hold',
    });
  } else if (acceptance.issues.length) {
    reasons.push({
      code: 'acceptance-incomplete',
      prerequisite: 'acceptance',
      message: 'The registered acceptance criteria have missing or disallowed verdicts.',
      actionId: 'hold',
    });
  }

  const hasSelectedMedia = preparedPackage?.selectedEvidenceKeys?.length;
  if (acceptance.criteria.length || hasSelectedMedia) {
    if (!source.recordedEvidence) {
      reasons.push({
        code: 'evidence-validation-unavailable',
        prerequisite: 'evidence',
        message: 'Recorded evidence validation is unavailable for this execution.',
        actionId: 'hold',
      });
    } else {
      const result = await source.recordedEvidence(run, preparedPackage);
      if (result.status !== 'valid')
        reasons.push({
          code: 'evidence-invalid',
          prerequisite: 'evidence',
          message: 'Required claim evidence is incomplete or invalid.',
          actionId: 'hold',
        });
    }
  }
  if (preparedPackage) {
    try {
      await source.selectedEvidence(run, preparedPackage);
    } catch {
      reasons.push({
        code: 'evidence-selection-invalid',
        prerequisite: 'evidence',
        message: 'The selected evidence bytes no longer match this gate package.',
        actionId: 'hold',
      });
    }

    let recordedPolicySatisfied = false;
    try {
      assertPublicationReviewPolicySatisfied(run, preparedPackage);
      recordedPolicySatisfied = true;
    } catch {
      recordedPolicySatisfied = false;
    }
    const validReviews: ReviewStatus[] = [];
    for (const review of qualifyingPassingReviews(run.engineState?.publishGate?.reviews ?? [])) {
      const artifact = resultArtifact(review);
      const raw = artifact ? await source.reviewResult(run, artifact) : undefined;
      if (raw) {
        const result = parseStructuredReviewFeedback(raw, artifact!);
        if (!result.incomplete && result.verdict === review.verdict) validReviews.push(review);
      }
    }
    try {
      assertPublicationReviewPolicySatisfied(
        {
          ...run,
          engineState: {
            ...run.engineState,
            publishGate: { ...run.engineState?.publishGate, reviews: validReviews },
          },
        },
        preparedPackage,
      );
    } catch {
      reasons.push({
        code: recordedPolicySatisfied ? 'review-result-invalid' : 'review-result-required',
        prerequisite: 'review',
        message: 'Required reviews need valid result artifacts for the current package.',
        actionId: 'request-review',
      });
    }
  }
  const progress = await source.progress(run);
  if (
    isTerminalRunStatus(run.status) ||
    run.status === 'paused' ||
    (run.engineState?.generation ?? 0) !== generation
  )
    reasons.push({
      code: 'run-gate-superseded',
      prerequisite: 'lifecycle',
      message: 'The run no longer owns this gate evaluation.',
      actionId: 'hold',
    });
  if (progress.kind === 'making-progress')
    reasons.push({
      code: 'run-work-progressing',
      prerequisite: 'lifecycle',
      message: 'Run work is still progressing.',
      actionId: 'hold',
    });
  if (progress.kind === 'unproven' || progress.kind === 'awaiting-input')
    reasons.push({
      code: 'run-progress-unconfirmed',
      prerequisite: 'lifecycle',
      message: 'The current runner operation cannot be confirmed idle.',
      actionId: 'hold',
    });
  return {
    state:
      progress.kind === 'making-progress' ? 'collecting' : reasons.length ? 'not-ready' : 'ready',
    identity: {
      runId: run.id,
      generation,
      headSha: preparedPackage?.headSha,
      packageHash: preparedPackage?.packageHash,
    },
    reasons,
  };
}

export function isPrerequisiteGatePayload(
  payload?: RunDecisionPayload,
): payload is ReadyGatePayload | ReviewGatePayload | NoChangeGatePayload {
  return payload?.kind === 'ready' || payload?.kind === 'review' || payload?.kind === 'no-change';
}

export function advancingGateAction(actionId: string): boolean {
  return (
    actionId === 'ready' ||
    isPublishApprovalAction(actionId) ||
    actionId === 'post' ||
    actionId === 'accept-no-change'
  );
}

export function gateActionsForReadiness<Action extends { id: string }>(
  actions: Action[],
  readiness: RunGateReadiness,
): Action[] {
  return actions.filter(
    (action) =>
      !advancingGateAction(action.id) || gateReasonsForAction(readiness, action.id).length === 0,
  );
}

function gateReasonsForAction(
  readiness: RunGateReadiness,
  actionId?: string,
): RunGatePrerequisiteReason[] {
  const reviewOverride = [
    APPROVE_PUBLISH_UNRESOLVED_ACTION,
    APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
    APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  ].some((id) => id === actionId);
  return readiness.reasons.filter(
    (reason) => !(reviewOverride && reason.prerequisite === 'review'),
  );
}

export async function assertRunGateReady(
  run: Run,
  preparedPackage: ReadyGatePrPackage | null,
  actionId?: string,
): Promise<void> {
  const readiness = await collectRunGateReadiness(run, preparedPackage);
  const reasons = gateReasonsForAction(readiness, actionId);
  if (reasons.length || readiness.state === 'collecting')
    throw new GatewayMethodError(
      'RUN_GATE_NOT_READY',
      reasons.map((reason) => reason.message).join(' ') || 'Run work is still progressing.',
      {
        details: { readiness },
        userAction: 'Resolve the listed prerequisites, then refresh the gate.',
      },
    );
}

/** Definitions remain on the existing decision so a later receipt can restore its actions. */
export function runGateDefinitionActions(decision: RunDecision): DecisionAction[] {
  return Array.isArray(decision.context?.gateActions)
    ? (decision.context.gateActions as DecisionAction[])
    : decision.actions;
}

/** Refresh the existing projection; it is never approval authority. */
export async function refreshRunGateReadiness(
  run: Run,
  overrides: Partial<GatePrerequisiteReaders> = {},
): Promise<Run> {
  const generation = run.engineState?.generation ?? 0;
  const pending = run.decisions.filter(
    (decision) => !decision.resolvedAt && isPrerequisiteGatePayload(decision.payload),
  );
  if (!pending.length || runSupersededSince(run, generation) || isTerminalRunStatus(run.status))
    return run;
  const progress = await (overrides.progress ?? readRunProgress)(run);
  const updates = await Promise.all(
    pending.map(async (decision) => {
      const payload = decision.payload!;
      const prepared = payload.kind === 'ready' ? (payload.prPackage ?? null) : null;
      const readiness = await collectRunGateReadiness(run, prepared, {
        ...overrides,
        progress: async () => progress,
      });
      const definitions = runGateDefinitionActions(decision);
      return {
        ...decision,
        actions: gateActionsForReadiness(definitions, readiness),
        context: { ...decision.context, gateActions: definitions },
        payload: { ...payload, gateReadiness: readiness },
      } as RunDecision;
    }),
  );
  const current = getRun(run.id);
  if (runSupersededSince(current, generation) || isTerminalRunStatus(current!.status))
    return current ?? run;
  // A resolution or package refresh that landed during I/O wins.
  const applicable = updates.filter((update) => {
    const before = pending.find((decision) => decision.id === update.id)!;
    const now = current!.decisions.find((decision) => decision.id === update.id);
    return now && !now.resolvedAt && now.payload === before.payload;
  });
  if (!applicable.length) return current!;
  const decisions = current!.decisions.map(
    (decision) => applicable.find((update) => update.id === decision.id) ?? decision,
  );
  const gate = applicable.at(-1)!;
  const readiness = (gate.payload as { gateReadiness: RunGateReadiness }).gateReadiness;
  const status = runDecisionWaitingStatus(
    current!,
    progress,
    gate.type === 'engine_review_posting' ? 'review_posting' : 'human_gate',
    readiness,
  );
  return current!.status === status && isDeepStrictEqual(current!.decisions, decisions)
    ? current!
    : updateRun(run.id, { status, decisions });
}
