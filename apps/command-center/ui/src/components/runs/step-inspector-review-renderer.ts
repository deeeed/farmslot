import { html, nothing } from 'lit';

import { colors } from '../../styles/theme-tokens.js';

import type { ReviewLoopAttempt } from './step-inspector-model.js';

/**
 * Render one review-loop attempt row. Extracted from <step-inspector> so the
 * fixDelta binding is unit-testable without a DOM: the "worker fix applied"
 * line must show whenever a fixDelta exists (`hasFixDelta`), with the ` · <path>`
 * suffix only when a diffPath is present. A degraded snapshot (diffPath absent)
 * still shows the line. See step-inspector-review-renderer.test.ts.
 */
export function renderReviewAttempt(attempt: ReviewLoopAttempt, index: number): unknown {
  const { verdict, unresolvedCount: unresolved, issues, completedAt, loopNumber } = attempt;
  const color =
    verdict === 'pass'
      ? colors.statusOk
      : verdict === 'issues'
        ? colors.statusWarn
        : verdict === 'failed'
          ? colors.statusFail
          : colors.textMuted;
  return html`
    ${attempt.hasFixDelta
      ? html`<div class="review-loop-fix">
          worker fix applied${attempt.fixDeltaPath ? ` · ${attempt.fixDeltaPath}` : ''}
        </div>`
      : nothing}
    <div class="review-loop-row ${verdict}">
      <div class="review-loop-badge" style="color:${color}">
        ${verdict === 'pass' ? 'pass' : verdict === 'issues' ? 'issues' : verdict}
      </div>
      <div class="review-loop-body">
        <div>
          Review attempt ${index + 1}${loopNumber !== index + 1 ? ` (loop ${loopNumber})` : ''}
          ${unresolved ? ` — ${unresolved} unresolved` : ' — no unresolved findings'}
        </div>
        ${completedAt
          ? html`<div class="review-loop-meta">completed ${completedAt}</div>`
          : nothing}
        ${issues.map(
          (issue) => html`
            <div class="review-loop-issue">
              <span class="review-loop-file"
                >${issue.file}${issue.line ? `:${issue.line}` : ''}</span
              >
              — ${issue.description}
            </div>
          `,
        )}
      </div>
    </div>
  `;
}
