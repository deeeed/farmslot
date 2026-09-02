import type { Run, RunDecision, RunRefreshPublishPackageResult } from '@farmslot/protocol';

export { readyResolveSelectionData } from '@farmslot/protocol';

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

export function readyActionRequiresConfirmation(actionId: string, packageGate: boolean): boolean {
  return isReadyPublicationApproval(actionId, packageGate);
}

export function readyDecisionSubmittingMessage(approving: boolean): string {
  return approving ? 'Submitting publication decision…' : 'Submitting decision…';
}

export function readyDecisionSuccessMessage(approving: boolean): string {
  return approving
    ? 'Publication approved — waiting for finalize to publish…'
    : 'Decision submitted — waiting for the pipeline to continue…';
}

export function refreshedReadyEvidenceSelection(
  result: ReadyRefreshPublishPackageResult,
): string[] | null {
  if (!Array.isArray(result.preservedEvidenceKeys)) return null;
  const added = Array.isArray(result.addedEvidenceKeys) ? result.addedEvidenceKeys : [];
  return [...result.preservedEvidenceKeys, ...added];
}

export function refreshedReadyDecision(
  run: Pick<Run, 'decisions'>,
  decisionId: string,
): RunDecision | null {
  return run.decisions.find((decision) => decision.id === decisionId) ?? null;
}

export function applyReadyPackageRefreshResult(
  result: RunRefreshPublishPackageResult,
  decisionId: string,
  target: {
    setRun: (run: Run) => void;
    setDecision: (decision: RunDecision) => void;
    clearConfirmation: () => void;
    setSelectedEvidenceKeys: (keys: string[]) => void;
  },
): void {
  const decision = refreshedReadyDecision(result.run, decisionId);
  if (!decision) throw new Error('Refreshed package response omitted the active decision');
  target.setRun(result.run);
  target.setDecision(decision);
  target.clearConfirmation();
  const nextSelection = refreshedReadyEvidenceSelection(result);
  if (nextSelection) target.setSelectedEvidenceKeys(nextSelection);
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
