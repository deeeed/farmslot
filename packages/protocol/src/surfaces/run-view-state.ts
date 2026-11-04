import { viewListField, viewTextField, viewToggleField } from './view-state.js';

/** Shared logical run panels, before a person selects URL overrides. */
export const RUN_DETAIL_PANEL_DEFAULTS = {
  'run-step-progress': true,
  'run-review-history': false,
  'run-artifacts': false,
  'run-acceptance': true,
  'run-results': true,
  'run-sessions': false,
  'run-posture': false,
  'run-grade': false,
  'run-transfers': false,
} as const;

export type RunDetailPanelId = keyof typeof RUN_DETAIL_PANEL_DEFAULTS;

export const RUN_VIEW_FIELDS = {
  panels: viewTextField('panels'),
  rounds: viewListField('round'),
};

export function runDetailPanelField(id: RunDetailPanelId) {
  return viewToggleField(RUN_VIEW_FIELDS.panels.key, id, RUN_DETAIL_PANEL_DEFAULTS[id]);
}

/** Evidence at the decision's recorded scope, without selecting a later recipe run. */
export const DECISION_EVIDENCE_RECIPE_RUN_PARAM = 'decision-evidence';

export function acceptanceClaimField(id: string) {
  return viewToggleField(RUN_VIEW_FIELDS.panels.key, `claim:${id}`, false);
}
