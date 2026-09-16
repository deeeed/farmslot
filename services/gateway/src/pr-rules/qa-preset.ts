import {
  DEFAULT_PR_REVIEW_OPTIONS,
  type ProjectQaConfig,
  type ProjectWorkflowDefaults,
  prReviewPurpose,
  prReviewWorkflow,
  type PRRulePreviewItem,
  resolvePRWorkflowDefaults,
  ReviewQaConfigurationError,
  selectQaProfile,
} from '@farmslot/protocol';

/** Resolve defaults before deduplication so implicit and explicit selections share one purpose. */
export function resolvePreviewQaPreset(
  item: PRRulePreviewItem,
  config?: ProjectQaConfig,
  workflowDefaults?: ProjectWorkflowDefaults,
): void {
  const options = item.review ?? DEFAULT_PR_REVIEW_OPTIONS;
  if (prReviewWorkflow(options) !== 'qa') return;
  try {
    const defaults = resolvePRWorkflowDefaults({ workflow: 'qa', farm: workflowDefaults }).review;
    const selected = selectQaProfile(config, options.qaProfileId ?? defaults.qaProfileId, {
      ...defaults.qaInputs,
      ...options.qaInputs,
    });
    const { validationDepth: _legacyDepth, busySession: _busySession, ...current } = options;
    const configured = prReviewPurpose(options);
    item.review = {
      ...current,
      sessionIntent: 'reset',
      scope: 'full',
      workflow: 'qa',
      qaProfileId: selected.profile.id,
      qaInputs: selected.inputs,
    };
    item.reviewPurpose = { configured, resolved: prReviewPurpose(item.review) };
  } catch (error) {
    if (!(error instanceof ReviewQaConfigurationError)) throw error;
    // A missing/removed preset is an actionable configuration state, not an empty successful preview.
    item.configurationErrors.push(error.message);
  }
}
