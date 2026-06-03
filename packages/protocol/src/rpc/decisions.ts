import type { PendingDecision } from '../contracts/index.js';

export interface DecisionResolveParams {
  decisionId: string;
  actionId: string;
}
export interface DecisionListResult {
  decisions: PendingDecision[];
}
