import type { PublicationTarget, ReadyGatePayload, RunDecision } from '../contracts/runs.js';
import type { RunResolveDecisionParams } from '../rpc/run.js';

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
  publicationTarget?: PublicationTarget;
  selectedEvidenceKeys?: string[];
  selectionData?: Record<string, unknown>;
}): RunResolveDecisionParams {
  const payload =
    input.decision.payload?.kind === 'ready'
      ? (input.decision.payload as ReadyGatePayload)
      : undefined;
  const selectionData = readyResolveSelectionData({
    payload,
    publicationTarget: input.publicationTarget,
    selectedEvidenceKeys: input.selectedEvidenceKeys,
    extraSelectionData: input.selectionData,
  });
  return {
    runId: input.runId,
    decisionId: input.decision.id,
    actionId: input.actionId,
    ...(selectionData ? { selectionData } : {}),
  };
}
