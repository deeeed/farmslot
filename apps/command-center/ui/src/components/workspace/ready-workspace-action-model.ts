import type { PublicationTarget, ReadyGatePayload, RunDecision } from '@farmslot/protocol';

export interface ReadyRefreshPublishPackageResult {
  preservedEvidenceKeys?: string[];
  droppedEvidence?: { key: string; reason: string }[];
  droppedEvidenceKeys?: string[];
  addedEvidenceKeys?: string[];
  packageHash?: string;
}

export function readyDecisionActionStateKey(decision?: RunDecision): string {
  return `${decision?.id ?? ''}:${decision?.resolvedAt ?? ''}:${decision?.resolvedAction ?? ''}`;
}

export function isReadyPublicationApproval(actionId: string, packageGate: boolean): boolean {
  return actionId === 'approve-publish' || (packageGate && actionId === 'ready');
}

export function readyDecisionSubmittingMessage(approving: boolean): string {
  return approving ? 'Submitting publication decision…' : 'Submitting decision…';
}

export function readyDecisionSuccessMessage(approving: boolean): string {
  return approving
    ? 'Publication approved — waiting for finalize to publish…'
    : 'Decision submitted — waiting for the pipeline to continue…';
}

export function readyResolveSelectionData(input: {
  payload?: ReadyGatePayload;
  publicationTarget: PublicationTarget;
  selectedEvidenceKeys: string[];
  extraSelectionData?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const extraSelectionData = input.extraSelectionData ?? {};
  if (!input.payload?.prPackage) {
    return Object.keys(extraSelectionData).length ? extraSelectionData : undefined;
  }
  return {
    publicationTarget: input.publicationTarget,
    selectedEvidenceKeys: input.selectedEvidenceKeys,
    packageId: input.payload.prPackage.id,
    packageHash: input.payload.prPackage.packageHash,
    packageHeadSha: input.payload.prPackage.headSha,
    ...extraSelectionData,
  };
}

export function refreshedReadyEvidenceSelection(
  result: ReadyRefreshPublishPackageResult,
): string[] | null {
  if (!Array.isArray(result.preservedEvidenceKeys)) return null;
  const added = Array.isArray(result.addedEvidenceKeys) ? result.addedEvidenceKeys : [];
  return [...result.preservedEvidenceKeys, ...added];
}

export function readyRefreshPublishPackageFeedback(result: ReadyRefreshPublishPackageResult): {
  message: string;
  tone: 'success' | 'error';
} {
  const dropped = result.droppedEvidenceKeys?.length ?? 0;
  const added = result.addedEvidenceKeys?.length ?? 0;
  const firstDropReason = result.droppedEvidence?.[0]?.reason;
  const summary = [
    `Package refreshed${result.packageHash ? ` · ${result.packageHash.slice(0, 12)}` : ''}`,
    dropped
      ? `${dropped} selection${dropped === 1 ? '' : 's'} dropped${firstDropReason ? `: ${firstDropReason}` : ''}`
      : '',
    added ? `${added} new evidence item${added === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return {
    message: summary.join(' · '),
    tone: dropped ? 'error' : 'success',
  };
}
