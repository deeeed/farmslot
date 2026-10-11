import { html, nothing } from 'lit';

import type { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import '../shared/review-dispatch-picker.js';

export interface PublicationReviewConfigRenderContext {
  enabled: boolean;
  viewModel: ReviewDispatchViewModel;
  qaPreset: string | null | undefined;
  changed: () => void;
}

export function renderPublicationReviewConfig(ctx: PublicationReviewConfigRenderContext) {
  if (!ctx.enabled) return nothing;
  return html`<div class="publication-review-panel">
    <div class="section-label">Publication reviews</div>
    <p class="section-help">
      Reviews run in separate sessions. Configure the ordered reviews required before publication.
    </p>
    <review-dispatch-picker
      .viewModel=${ctx.viewModel}
      .review=${true}
      @review-dispatch-change=${ctx.changed}
      @review-dispatch-status-change=${ctx.changed}
    ></review-dispatch-picker>
    <p class="section-help" data-testid="publication-review-qa-note">
      Reviews inspect source only. Runtime validation runs separately with QA.
      ${ctx.qaPreset === undefined
        ? 'Select a project to see its QA preset.'
        : ctx.qaPreset === null
          ? 'This project has no QA preset configured.'
          : `Farm QA preset: ${ctx.qaPreset}.`}
    </p>
  </div>`;
}
