import type { DecisionAction, RunDecision } from '../contracts/runs.js';

export const INTERACTIVE_HANDOFF_SIGNAL_ACTION = 'signal-written';
export const INTERACTIVE_HANDOFF_EXTEND_ACTION = 'continue';
export const DEFAULT_MONITOR_EXTEND_MINUTES = 90;

const TIMEOUT_NOTE_RE = /exceeded (\d+) minute timeout/;

export function parseInteractiveHandoffTimeoutMinutes(
  description: string | undefined,
): number | undefined {
  const match = description?.match(TIMEOUT_NOTE_RE);
  if (!match) return undefined;
  const minutes = Number(match[1]);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
}

export function interactiveHandoffExtendMinutes(
  decision: Pick<RunDecision, 'description' | 'context'>,
): number {
  const fromContext = decision.context?.extendMinutes;
  if (typeof fromContext === 'number' && Number.isFinite(fromContext) && fromContext > 0) {
    return Math.round(fromContext);
  }
  return (
    parseInteractiveHandoffTimeoutMinutes(decision.description) ?? DEFAULT_MONITOR_EXTEND_MINUTES
  );
}

export function extendMonitoringAction(minutes: number): DecisionAction {
  const mins =
    Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : DEFAULT_MONITOR_EXTEND_MINUTES;
  return {
    id: INTERACTIVE_HANDOFF_EXTEND_ACTION,
    label: `Extend monitoring ${mins} min`,
    style: 'secondary',
    description: `Keep watching the worker for another ${mins} minutes. Does not require SIGNAL.json.`,
  };
}

export function interactiveHandoffDecisionActions(opts?: {
  extendMinutes?: number;
}): DecisionAction[] {
  const actions: DecisionAction[] = [
    {
      id: INTERACTIVE_HANDOFF_SIGNAL_ACTION,
      label: 'Check SIGNAL.json & resume',
      style: 'primary',
      description:
        'Reads SIGNAL.json on the slot. Resumes the run only if it contains a fresh terminal status.',
    },
  ];
  if (opts?.extendMinutes != null) {
    actions.push(extendMonitoringAction(opts.extendMinutes));
  }
  actions.push({ id: 'abort', label: 'Abort Run', style: 'danger' });
  return actions;
}

export function interactiveHandoffAllowsExtend(
  decision: Pick<RunDecision, 'type' | 'actions' | 'description' | 'context'>,
): boolean {
  if (decision.type !== 'monitor_interactive_handoff') return false;
  if (decision.actions.some((action) => action.id === INTERACTIVE_HANDOFF_EXTEND_ACTION)) {
    return true;
  }
  return parseInteractiveHandoffTimeoutMinutes(decision.description) != null;
}

export function visibleInteractiveHandoffActions(
  decision: Pick<RunDecision, 'type' | 'actions' | 'description' | 'context'>,
): DecisionAction[] {
  if (!interactiveHandoffAllowsExtend(decision)) return decision.actions;
  if (decision.actions.some((action) => action.id === INTERACTIVE_HANDOFF_EXTEND_ACTION)) {
    return decision.actions;
  }
  const extend = extendMonitoringAction(interactiveHandoffExtendMinutes(decision));
  const abortIdx = decision.actions.findIndex((action) => action.id === 'abort');
  if (abortIdx === -1) return [...decision.actions, extend];
  return [...decision.actions.slice(0, abortIdx), extend, ...decision.actions.slice(abortIdx)];
}

export function isAllowedRunDecisionAction(
  decision: Pick<RunDecision, 'type' | 'actions' | 'description' | 'context'>,
  actionId: string,
): boolean {
  if (decision.actions.some((action) => action.id === actionId)) return true;
  return actionId === INTERACTIVE_HANDOFF_EXTEND_ACTION && interactiveHandoffAllowsExtend(decision);
}
