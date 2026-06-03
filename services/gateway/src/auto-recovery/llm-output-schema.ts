import {
  type FailureCategory,
  type IntelligenceActionProposedType,
  RECOVERABLE_FAILURE_CATEGORIES,
  type RunRecoveryProposalConfidence,
} from '@farmslot/protocol';

import { validateProposedAction } from './authority-channels.js';
export interface LlmRecoveryVerdict {
  category?: FailureCategory;
  confidence: RunRecoveryProposalConfidence;
  proposedAction?: { type: IntelligenceActionProposedType; stepName?: string; tmuxKeys?: string };
  warning?: string;
}
function isConfidence(value: unknown): value is RunRecoveryProposalConfidence {
  return value === 'high' || value === 'medium' || value === 'low';
}
export function parseLlmRecoveryOutput(raw: unknown): LlmRecoveryVerdict {
  if (!raw || typeof raw !== 'object')
    return { confidence: 'low', warning: 'LLM output was not an object' };
  const obj = raw as Record<string, unknown>;
  const confidence = isConfidence(obj.confidence) ? obj.confidence : 'low';
  const category =
    typeof obj.category === 'string' &&
    RECOVERABLE_FAILURE_CATEGORIES.has(obj.category as FailureCategory)
      ? (obj.category as FailureCategory)
      : undefined;
  if (obj.proposedAction !== undefined) {
    const validation = validateProposedAction(obj.proposedAction);
    if (!validation.ok) return { category, confidence: 'low', warning: validation.reason };
    const action = obj.proposedAction as Record<string, unknown>;
    return {
      category,
      confidence,
      proposedAction: {
        type: validation.type,
        ...(typeof action.stepName === 'string' ? { stepName: action.stepName } : {}),
        ...(typeof action.tmuxKeys === 'string' ? { tmuxKeys: action.tmuxKeys } : {}),
      },
    };
  }
  return { category, confidence };
}
