/**
 * The result decision view model that Command Center and Companion share (ADR-065
 * Amendment 7): a run held `needs-decision` shows why it stopped, its findings or
 * refused prerequisite, what it delivered, and three actions. Each client only
 * renders this; neither recomputes a label, an order or an availability.
 */

import {
  RESULT_DECISION_ACTION_LABELS,
  type ResultDecisionActionId,
  type ResultDecisionActionState,
  type ResultDecisionPayload,
  type RunDecision,
  type RunDecisionPayload,
} from '@farmslot/protocol';

export { pendingResultDecision, type ResultDecision } from '@farmslot/protocol';

/**
 * A result decision is answered where its reason field and unavailable actions show:
 * Command Center's run detail and Companion's decision workspace. Lists link there
 * instead of offering its actions.
 */
export function isResultDecision(decision: { payload?: RunDecisionPayload }): boolean {
  return decision.payload?.kind === 'result-decision';
}

/**
 * The output reviews that pending result decisions hold as their evidence panel.
 * Lists skip them: the gateway refuses their Close run and Mark reviewed until the
 * result decision settles.
 */
export function evidenceOnlyDecisionIds(
  decisions: readonly { payload?: RunDecisionPayload; resolvedAt?: string }[],
): Set<string> {
  return new Set(
    decisions.flatMap((decision) =>
      !decision.resolvedAt &&
      decision.payload?.kind === 'result-decision' &&
      decision.payload.outputReviewDecisionId
        ? [decision.payload.outputReviewDecisionId]
        : [],
    ),
  );
}

export interface ResultDecisionItem {
  /** File and line for a finding, or the prerequisite's reference. */
  location?: string;
  description: string;
}

export interface ResultDecisionActionView {
  id: ResultDecisionActionId;
  label: string;
  style: 'primary' | 'secondary' | 'danger';
  available: boolean;
  unavailableReason?: string;
  requiresReason: boolean;
  /** One line under an available action that would otherwise surprise. */
  note?: string;
}

export interface ResultDecisionView {
  decisionId: string;
  /** One sentence: why the run stopped. */
  reason: string;
  /** The findings at the delivered head, or the refused prerequisite's reasons. */
  detail: { title: string; items: ResultDecisionItem[] } | null;
  delivered: { label: string; value: string };
  outputReviewDecisionId?: string;
  actions: ResultDecisionActionView[];
}

const ACTIONS: Record<
  ResultDecisionActionId,
  Pick<ResultDecisionActionView, 'label' | 'style' | 'note'>
> = {
  'send-back': { label: RESULT_DECISION_ACTION_LABELS['send-back'], style: 'primary' },
  'accept-result': {
    label: RESULT_DECISION_ACTION_LABELS['accept-result'],
    style: 'secondary',
    note: 'Settles the run as done. Publishes nothing.',
  },
  'close-result': { label: RESULT_DECISION_ACTION_LABELS['close-result'], style: 'danger' },
};
const ORDER = Object.keys(ACTIONS) as ResultDecisionActionId[];

function actionView(state: ResultDecisionActionState): ResultDecisionActionView {
  const { note, ...presentation } = ACTIONS[state.id];
  return {
    id: state.id,
    ...presentation,
    available: state.available,
    ...(state.available
      ? note
        ? { note }
        : {}
      : { unavailableReason: state.unavailableReason ?? 'Not available for this run.' }),
    requiresReason: state.requiresReason,
  };
}

export function resultDecisionView(
  decision: Pick<RunDecision, 'id'> & { payload: ResultDecisionPayload },
): ResultDecisionView {
  const { payload } = decision;
  const findings = payload.findings ?? [];
  const detail = findings.length
    ? {
        title: `Findings (${findings.length})`,
        items: findings.map((finding) => ({
          location: finding.line ? `${finding.file}:${finding.line}` : finding.file,
          description: finding.description,
        })),
      }
    : payload.refusal?.reasons.length
      ? {
          title: `Refused prerequisites (${payload.refusal.reasons.length})`,
          items: payload.refusal.reasons.map((reason) => ({
            ...(reason.reference ? { location: reason.reference } : {}),
            description: reason.message,
          })),
        }
      : payload.refusal && payload.refusal.message !== payload.reason
        ? { title: 'Refused prerequisite', items: [{ description: payload.refusal.message }] }
        : null;
  const delivered =
    'headSha' in payload.delivered
      ? {
          label: 'Delivered head',
          value: `${payload.delivered.headSha.slice(0, 12)}${payload.delivered.branch ? ` · ${payload.delivered.branch}` : ''}`,
        }
      : { label: 'Delivered report', value: payload.delivered.reportPath };
  return {
    decisionId: decision.id,
    reason: payload.reason,
    detail,
    delivered,
    ...(payload.outputReviewDecisionId
      ? { outputReviewDecisionId: payload.outputReviewDecisionId }
      : {}),
    actions: [...payload.actions]
      .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
      .map(actionView),
  };
}

/** Whether an action can be sent: available, and with the written reason it requires. */
export function resultDecisionActionReady(
  action: Pick<ResultDecisionActionView, 'available' | 'requiresReason'>,
  reason: string,
): boolean {
  return action.available && (!action.requiresReason || reason.trim().length > 0);
}
