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
  HUMAN_GATE_DECISION_TYPE,
  humanGateGuard,
  type HumanGateGuardDecision,
  type HumanGateGuardState,
} from '../lib/gate-review';
import type { GatewayClient } from '../lib/gateway-client';

import { type RunAcceptance, useRunAcceptance } from './useRunAcceptance';

export interface HumanGateGuard extends HumanGateGuardState {
  acceptance: RunAcceptance;
}

export function useHumanGateGuard(
  client: GatewayClient | null,
  run: Run | null,
  decision: (HumanGateGuardDecision & Pick<RunDecision, 'id' | 'type'>) | null,
): HumanGateGuard | null {
  const gate = decision?.type === HUMAN_GATE_DECISION_TYPE ? decision : null;
  const acceptance = useRunAcceptance(client, gate ? run : null, { decisionId: gate?.id });
  return useMemo(
    () => (gate ? { acceptance, ...humanGateGuard(run, gate, acceptance) } : null),
    [acceptance, gate, run],
  );
}
