/**
 * The publish guard for an open `engine_human_gate` decision, shared by every
 * Companion surface that can send the gate's actions: the run's acceptance
 * criteria, each reviewer's latest verdict, and the decision's actions with the
 * publish approvals withheld while either is incomplete. Null for any other
 * decision, which has no publish guard.
 */
import { useMemo } from 'react';

import type { Run, RunDecision } from '@farmslot/protocol';

import {
  type ApprovePublishGuard,
  approvePublishGuard,
  type GateDecision,
  gateIndependentReviews,
  gateRequiredReviewCount,
  type GateReviewAction,
  gateReviewActions,
  type GateReviewVerdict,
  HUMAN_GATE_DECISION_TYPE,
  latestReviewVerdicts,
} from '../lib/gate-review';
import type { GatewayClient } from '../lib/gateway-client';

import { type RunAcceptance, useRunAcceptance } from './useRunAcceptance';

export interface HumanGateGuard {
  acceptance: RunAcceptance;
  reviews: GateReviewVerdict[];
  guard: ApprovePublishGuard;
  actions: GateReviewAction[];
}

export type HumanGateGuardDecision = GateDecision & Pick<RunDecision, 'type' | 'actions'>;

export function useHumanGateGuard(
  client: GatewayClient | null,
  run: Run | null,
  decision: HumanGateGuardDecision | null,
): HumanGateGuard | null {
  const gate = decision?.type === HUMAN_GATE_DECISION_TYPE ? decision : null;
  const acceptance = useRunAcceptance(client, gate ? run : null);
  return useMemo(() => {
    if (!gate) return null;
    const reviews = latestReviewVerdicts(gateIndependentReviews(run, gate));
    const guard = approvePublishGuard({
      acceptance: acceptance.view,
      acceptanceError: acceptance.error,
      reviews,
      requiredReviews: gateRequiredReviewCount(gate),
    });
    return { acceptance, reviews, guard, actions: gateReviewActions(gate.actions, guard) };
  }, [acceptance, gate, run]);
}
