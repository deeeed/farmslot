import { Events, type Run, type RunRefreshPublishPackageParams } from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import { refreshPublishPackage } from '../../run-engine/publish-package-refresh.js';

export interface ClaimReceiptRefreshDependencies {
  refreshPackage?: (params: RunRefreshPublishPackageParams) => Promise<{ run: Run }>;
}

interface ClaimReceiptRefreshOptions extends ClaimReceiptRefreshDependencies {
  run: Run;
  decisionId?: string;
  receiptId: string;
  kind: 'override' | 'judgment';
  emit: (event: string, payload: unknown) => void;
}

/** Persisted claim decisions refresh the existing gate, without approving or resolving it. */
export async function refreshClaimReceiptPackage({
  run,
  decisionId,
  receiptId,
  kind,
  emit,
  refreshPackage = refreshPublishPackage,
}: ClaimReceiptRefreshOptions): Promise<Run> {
  emit(Events.RUN_UPDATED, { run });
  const decision = run.decisions.find(
    (entry) => entry.id === decisionId && !entry.resolvedAt && entry.payload?.kind === 'ready',
  );
  if (decision?.payload?.kind !== 'ready') return run;
  const applied =
    kind === 'override'
      ? decision.payload.prPackage?.claimOverrideReceiptIds
      : decision.payload.prPackage?.visualJudgmentReceiptIds;
  if (applied?.includes(receiptId)) return run;
  let updated: Run;
  try {
    updated = (await refreshPackage({ runId: run.id, decisionId })).run;
  } catch (error) {
    // The receipt is durable. Retrying refresh must not create another receipt.
    throw new GatewayMethodError(
      kind === 'override' ? 'CLAIM_OVERRIDE_REFRESH_REQUIRED' : 'VISUAL_JUDGMENT_REFRESH_REQUIRED',
      `${kind === 'override' ? 'Override' : 'Judgment'} saved, but package refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        userAction: `Retry the ${kind} or refresh the publication package.`,
        details: { runId: run.id, receiptId },
      },
    );
  }
  emit(Events.RUN_UPDATED, { run: updated });
  return updated;
}
