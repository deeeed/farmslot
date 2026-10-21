import { html, nothing } from 'lit';

import type { ReviewHistoryRound } from '@farmslot/review-dispatch';

import { colors } from '../../styles/theme-tokens.js';

import { formatDuration } from './run-utils.js';

/** Platform rendering only. Both clients receive these same recorded round and fix facts. */
export function renderReviewAttempt(
  round: ReviewHistoryRound,
  index: number,
  openArtifact: (path: string) => void = () => undefined,
): unknown {
  const color =
    round.verdict === 'pass'
      ? colors.statusOk
      : round.verdict === 'failed'
        ? colors.statusFail
        : colors.statusWarn;
  return html`<details
    class="review-history-round"
    ?open=${index === -1}
    data-round=${round.loopNumber}
  >
    <summary>
      <strong>Round ${round.loopNumber}</strong><span style="color:${color}">${round.verdict}</span>
      <span>${round.runner} / ${round.model}</span>
      <span>${round.modeLabel}</span>
      <span
        >${round.durationMs !== null
          ? formatDuration(round.durationMs)
          : 'Duration not recorded'}</span
      >
    </summary>
    <div class="review-history-body">
      <div>Started ${round.startedAt ?? 'not recorded'} · ${round.unresolvedLabel}</div>
      ${round.earlierAttempts.map(
        (attempt) =>
          html`<div class="review-loop-meta">
            Earlier attempt: ${attempt.status} · ${attempt.startedAt ?? 'start not recorded'} ·
            ${attempt.durationMs !== null
              ? formatDuration(attempt.durationMs)
              : 'duration not recorded'}
          </div>`,
      )}
      <div>${round.reviewRange} · ${round.validationDepth}</div>
      ${round.hasFix
        ? html`<div class="review-loop-fix">
            Fix before round ${round.loopNumber}: ${round.fixRange ?? 'SHA not recorded'} ·
            ${round.fixStat ?? 'Diffstat not recorded'} ·
            ${round.fixDurationMs !== null
              ? formatDuration(round.fixDurationMs)
              : 'Fix duration not recorded'}
            <div>Resolved findings: ${round.resolution}</div>
          </div>`
        : nothing}
      ${round.fixRunning
        ? html`<div class="review-loop-fix">
            Worker fixing findings · started ${round.activeFixStartedAt ?? 'not recorded'}
          </div>`
        : nothing}
      <div>${round.findingsLabel}</div>
      ${round.findings.map(
        (finding) =>
          html`<div class="review-loop-issue">
            <div class="review-loop-file">
              ${finding.file}${finding.line ? `:${finding.line}` : ''} · ${finding.severity}
            </div>
            <strong>${finding.title}</strong>${finding.details
              ? html`<div>${finding.details}</div>`
              : nothing}
          </div>`,
      )}
      ${round.timing.length
        ? html`<details>
            <summary>Checklist timing · ${round.timing.length} steps</summary>
            ${round.timing.map(
              (step) =>
                html`<div>
                  ${step.stepNumber}. ${step.label} · ${formatDuration(step.durationMs)}
                </div>`,
            )}
          </details>`
        : nothing}
      ${round.unavailable.length
        ? html`<div class="review-loop-meta">
            Some history artifacts are unavailable. Refresh history to try again.
          </div>`
        : nothing}
      <div class="review-history-actions">
        ${round.diffPath && round.reviewDiffRetained
          ? html`<button @click=${() => openArtifact(round.diffPath!)}>Reviewed diff</button>`
          : nothing}
        ${round.fixDiffPath
          ? html`<button
              ?disabled=${Boolean(round.fixDiffError)}
              title=${round.fixDiffError ?? ''}
              @click=${() => openArtifact(round.fixDiffPath!)}
            >
              Changed files and diff
            </button>`
          : nothing}
      </div>
    </div>
  </details>`;
}
