import type { FamilyDiffKind, FlowType } from '@farmslot/protocol';

export function diffKindForFlow(flowType?: FlowType): FamilyDiffKind {
  return flowType === 'review-pr' ? 'review-input' : 'contribution';
}
