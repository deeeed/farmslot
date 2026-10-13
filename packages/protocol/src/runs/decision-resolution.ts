import type { ResourcePostureGateChoice } from '../contracts/resource-posture.js';
import type {
  PublicationTarget,
  ReadyGatePayload,
  RunDecision,
  SlotPickerPayload,
} from '../contracts/runs.js';
import type { ImprovementApplyParams, ImprovementApplyResult } from '../rpc/intelligence.js';
import { Methods } from '../rpc/registry.js';
import type { RunResolveDecisionParams } from '../rpc/run.js';

import { evidenceAttestationReason } from './publish-approval.js';
import { reviewPostingFingerprint } from './review-curation.js';

/** Candidate selection shared by the desktop and native decision renderers. */
export function slotPickerViewModel(payload: SlotPickerPayload, selectedSlotId?: string | null) {
  const candidates = payload.candidates.filter((candidate) => candidate.score >= 0);
  return {
    candidates,
    unavailableCount: payload.candidates.length - candidates.length,
    selectedSlotId: candidates.some((candidate) => candidate.slotId === selectedSlotId)
      ? (selectedSlotId ?? null)
      : null,
  };
}

export interface RunDecisionActionInput {
  runId: string;
  decision: Pick<RunDecision, 'id' | 'payload'> & Partial<Pick<RunDecision, 'type'>>;
  actionId: string;
  evidenceAttestationReason?: string;
  selectionData?: Record<string, unknown>;
  resourcePosture?: ResourcePostureGateChoice;
}

export type RunDecisionActionRequest =
  | { method: typeof Methods.IMPROVEMENT_APPLY; params: ImprovementApplyParams }
  | { method: typeof Methods.RUN_RESOLVE_DECISION; params: RunResolveDecisionParams };

/** Applying a proposal must write and validate it before resolving the decision. */
export function buildRunDecisionActionRequest(
  input: RunDecisionActionInput,
): RunDecisionActionRequest {
  if (input.decision.type === 'improvement' && input.actionId === 'apply') {
    return {
      method: Methods.IMPROVEMENT_APPLY,
      params: { runId: input.runId, decisionId: input.decision.id },
    };
  }
  return { method: Methods.RUN_RESOLVE_DECISION, params: buildRunResolveDecisionParams(input) };
}

/** A refusal or failed validation keeps the improvement card pending in both clients. */
export function improvementApplyOutcome(result: ImprovementApplyResult) {
  const refusals = result.refused ?? [];
  const passed = result.validationPassed && refusals.length === 0;
  const message = !result.validationPassed
    ? `Applied but validation FAILED:\n${(result.validationOutput ?? '').slice(0, 300)}`
    : refusals.length > 0
      ? `Applied ${result.applied.length}, refused ${refusals.length} change(s) — card stays pending:\n${refusals
          .map((refusal) => `${refusal.filePath}: ${refusal.reason}`)
          .join('\n')
          .slice(0, 300)}\nRefine the card so it re-reads the current file, then re-apply.`
      : `Applied ${result.applied.length} file(s). Validation passed.`;
  return { passed, message };
}

/**
 * Bind a ready-gate resolution to the exact package the operator reviewed.
 * Every publish surface must use this helper so stale-package protection cannot
 * drift between Command Center and CLI clients.
 */
export function readyResolveSelectionData(input: {
  payload?: ReadyGatePayload;
  publicationTarget?: PublicationTarget;
  selectedEvidenceKeys?: string[];
  extraSelectionData?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const extraSelectionData = input.extraSelectionData ?? {};
  if (!input.payload?.prPackage) {
    return Object.keys(extraSelectionData).length ? extraSelectionData : undefined;
  }
  const prPackage = input.payload.prPackage;
  return {
    publicationTarget:
      input.publicationTarget ?? input.payload.publicationTarget ?? prPackage.publicationTarget,
    selectedEvidenceKeys: input.selectedEvidenceKeys ?? prPackage.selectedEvidenceKeys ?? [],
    packageId: prPackage.id,
    packageHash: prPackage.packageHash,
    packageHeadSha: prPackage.headSha,
    ...extraSelectionData,
  };
}

/**
 * Construct the shared run-decision RPC contract for every operator client.
 * Action-specific selection data is preserved, while ready gates are
 * automatically bound to the exact package visible in that client.
 */
export function buildRunResolveDecisionParams(input: {
  runId: string;
  decision: Pick<RunDecision, 'id' | 'payload'>;
  actionId: string;
  evidenceAttestationReason?: string;
  triageAssessmentId?: string;
  publicationTarget?: PublicationTarget;
  selectedEvidenceKeys?: string[];
  selectionData?: Record<string, unknown>;
  /**
   * Operator resource-posture choice for the wait this decision ends (ADR-054).
   * Carried as a typed field so no client can invent its own cleanup policy in
   * free-form `selectionData`.
   */
  resourcePosture?: ResourcePostureGateChoice;
}): RunResolveDecisionParams {
  const attestationReason = evidenceAttestationReason(
    input.actionId,
    input.evidenceAttestationReason,
  );
  const payload =
    input.decision.payload?.kind === 'ready'
      ? (input.decision.payload as ReadyGatePayload)
      : undefined;
  let selectionData = readyResolveSelectionData({
    payload,
    publicationTarget: input.publicationTarget,
    selectedEvidenceKeys: input.selectedEvidenceKeys,
    extraSelectionData: input.selectionData,
  });
  if (input.actionId === 'post' && input.decision.payload?.kind === 'review') {
    selectionData = {
      reviewFingerprint: reviewPostingFingerprint(input.decision.payload),
      ...selectionData,
    };
  }
  return {
    runId: input.runId,
    decisionId: input.decision.id,
    actionId: input.actionId,
    ...(attestationReason !== undefined ? { evidenceAttestationReason: attestationReason } : {}),
    ...(input.triageAssessmentId !== undefined
      ? { triageAssessmentId: input.triageAssessmentId }
      : {}),
    ...(selectionData ? { selectionData } : {}),
    ...(input.resourcePosture ? { resourcePosture: input.resourcePosture } : {}),
  };
}
