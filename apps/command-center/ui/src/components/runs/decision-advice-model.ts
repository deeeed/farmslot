import { isDecisionAdviceDeclineAction, type RunDecision } from '@farmslot/protocol';

/** The panel is only mounted for pending decisions with two actionable alternatives. */
export function supportsDecisionAdvice(
  decision: Pick<RunDecision, 'actions' | 'resolvedAt' | 'type'>,
): boolean {
  if (
    decision.resolvedAt ||
    !['engine_collision', 'engine_prepare_profile_mismatch'].includes(decision.type) ||
    decision.actions.length < 3
  )
    return false;
  const distinct = new Set(decision.actions.map((action) => action.id));
  const meaningful = decision.actions.filter((action) => !isDecisionAdviceDeclineAction(action.id));
  return (
    distinct.size >= 3 &&
    meaningful.length >= 2 &&
    meaningful.every((action) => action.description?.trim())
  );
}
