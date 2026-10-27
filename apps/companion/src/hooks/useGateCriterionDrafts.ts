import { useState } from 'react';
import { Alert } from 'react-native';

import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import {
  buildRunResolveDecisionParams,
  evidenceAttestationAvailable,
  isPublishApprovalAction,
  Methods,
  publicationApprovalReasonFields,
  type ResourcePostureGateChoice,
  type Run,
  type RunDecision,
  type RunOverrideClaimResult,
  type RunResolveDecisionResult,
} from '@farmslot/protocol';
import {
  acceptanceClaimRows,
  codeReviewNoteSuggestion,
  criterionDraftReason,
  publicationGateCriteria,
} from '@farmslot/review-dispatch';

import type { GatewayClient } from '../lib/gateway-client';
import { useConnectionStore } from '../store/connection';

import { useCriterionDrafts } from './useCriterionDrafts';

interface GateCriterionDraftInput {
  runId?: string | null;
  decision: RunDecision | null;
  evidenceModel?: EvidenceReviewModel | null;
  client: GatewayClient | null;
}
interface DraftSubmitInput<T> {
  run: Run | null;
  decision: RunDecision;
  actionId: string;
  reason: string;
  selectionData?: Record<string, unknown>;
  resourcePosture?: ResourcePostureGateChoice | null;
  applied: (run: Run) => void;
  fallback?: () => Promise<T>;
}

/** Both native gate contexts use the same draft scope and live-only approval boundary. */
export function useGateCriterionDrafts({
  runId,
  decision,
  evidenceModel,
  client,
}: GateCriterionDraftInput) {
  const authorityEpoch = useConnectionStore((state) => state.authorityEpoch);
  const gatewayUrl = useConnectionStore((state) => state.gatewayUrl);
  const scope = JSON.stringify([
    runId,
    decision?.id,
    client?.authenticatedPrincipal?.id,
    gatewayUrl,
  ]);
  const payload = decision?.payload?.kind === 'ready' ? decision.payload : undefined;
  const model = useCriterionDrafts(scope, payload?.prPackage?.packageHash ?? '');
  const reasonScope = JSON.stringify([scope, payload?.prPackage?.packageHash, authorityEpoch]);
  const [reasonDraft, setReasonDraft] = useState<{ scope: string; text: string } | null>(null);
  const reasonInput = reasonDraft?.scope === reasonScope ? reasonDraft.text : '';
  const attestationReason = criterionDraftReason(model.entries, reasonInput);
  const setReason = (text: string) => setReasonDraft({ scope: reasonScope, text });
  const actions = {
    model,
    canSkip: () => true,
    choose: (id: string, choice: 'confirm' | 'skip', note?: string) => {
      if (client?.authenticatedPrincipal?.subjectKind !== 'person') return;
      const claim = acceptanceClaimRows({
        criteria: publicationGateCriteria(payload),
        ledger: payload?.acceptanceStatus ?? undefined,
        claims: evidenceModel?.claims,
      }).find((row) => row.id === id)?.source;
      if (!claim) return;
      const suggestion =
        choice === 'confirm' && claim.status?.proofMode === 'review'
          ? codeReviewNoteSuggestion(payload?.gateSummary?.review)
          : '';
      model.choose(
        claim,
        choice,
        note ?? suggestion,
        evidenceModel?.claimOverrideCandidate(id)?.recipeRunId,
      );
    },
  };
  const submit = <T>(input: DraftSubmitInput<T>): Promise<RunResolveDecisionResult | T> => {
    if (!isPublishApprovalAction(input.actionId) || !model.entries.length) {
      if (!input.fallback) throw new Error('No criterion approval is pending.');
      return input.fallback();
    }
    if (!input.run) throw new Error('Load the current run before approving its drafts.');
    if (!client) throw new Error('Connect to the gateway before approving.');
    const owner = client.authenticatedPrincipal?.id;
    const run = input.run;
    return model.approve({
      ...input,
      run,
      execution: (id) => evidenceModel?.claimOverrideCandidate(id)?.recipeRunId,
      requestSkip: (method, params) => client.request<RunOverrideClaimResult>(method, params, null),
      assertCurrent: () => {
        const current = useConnectionStore.getState();
        if (
          current.authorityEpoch !== authorityEpoch ||
          current.client !== client ||
          client.authenticatedPrincipal?.id !== owner
        )
          throw new Error('The gate or signed-in authority changed.');
      },
      applied: (run) => input.applied(run),
      send: (next, actionId, reason) =>
        client.request<RunResolveDecisionResult>(
          Methods.RUN_RESOLVE_DECISION,
          buildRunResolveDecisionParams({
            runId: run.id,
            decision: next,
            actionId,
            selectionData: input.selectionData,
            ...(input.resourcePosture ? { resourcePosture: input.resourcePosture } : {}),
            ...publicationApprovalReasonFields(
              actionId,
              reason,
              evidenceAttestationAvailable(
                next.payload?.kind === 'ready' ? next.payload.gateReadiness : undefined,
                actionId,
              ),
            ),
          }),
          null,
        ),
    });
  };
  const reportError = (version: number, title: string) => (error: Error) => {
    // An old view's reply must not interrupt the current gate or signed-in owner.
    if (version === model.scopeVersion) Alert.alert(title, error.message);
  };
  return { model, scope, actions, submit, reasonInput, attestationReason, setReason, reportError };
}
