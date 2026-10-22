import { html, nothing } from 'lit';

import type {
  ReviewHistoryFinding,
  ReviewHistoryFix,
  ReviewHistoryRound,
} from '@farmslot/review-dispatch';

import { formatDuration } from './run-utils.js';

export function renderReviewAttempt(
  round: ReviewHistoryRound,
  loading: boolean,
  openArtifact: (path: string) => void,
  openFinding: (finding: ReviewHistoryFinding) => void,
  renderSource: (finding: ReviewHistoryFinding) => unknown,
): unknown {
  const running = round.verdict === 'pending';
  const duration =
    round.durationMs ??
    (running && round.startedAt ? Date.now() - Date.parse(round.startedAt) : null);
  return html`<details
    class="review-history-round"
    data-round=${round.roundNumber}
    data-event=${round.key}
  >
    <summary>
      <span class="round-heading"
        ><strong>Round ${round.roundNumber}</strong>
        <span class="chip verdict ${round.verdictTone}"
          >${loading && round.verdict === 'Result not recorded'
            ? 'Loading result…'
            : running
              ? 'Running'
              : round.verdict}</span
        >
      </span>
      <span class="round-meta"
        >${round.runner} / ${round.model} <span class="chip">${round.modeLabel}</span></span
      >
      <span class="round-meta"
        ><code title=${round.headSha ?? ''}
          >${round.headSha?.slice(0, 8) ?? (loading ? 'Loading head…' : 'Head pending')}</code
        >
        <span
          >${duration !== null
            ? `${running ? 'Running · ' : ''}${formatDuration(Math.max(0, duration))}`
            : loading
              ? 'Loading timing…'
              : 'Timing unavailable'}</span
        >
      </span>
    </summary>
    <div class="review-history-body">
      ${round.failureReason
        ? html`<div class="history-warning" role="status">${round.failureReason}</div>`
        : nothing}
      ${round.startedAt
        ? html`<div class="review-loop-meta">
            Started ${new Date(round.startedAt).toLocaleString()} · ${round.reviewRange}
          </div>`
        : nothing}
      ${round.usageLabel ? html`<div class="review-loop-meta">${round.usageLabel}</div>` : nothing}
      ${round.findings.map(
        (finding) =>
          html`<article class="review-loop-issue" data-finding=${finding.id}>
            <div class="finding-heading">
              <span class="chip severity">${finding.severity}</span
              ><span class="chip finding-status ${finding.status}">${finding.statusLabel}</span>
            </div>
            <button
              class="finding-location"
              ?disabled=${!round.headSha || !finding.line}
              @click=${() => openFinding(finding)}
            >
              ${finding.file}${finding.line ? `:${finding.line}` : ''}
            </button>
            <div class="finding-text">
              <strong>${finding.title}</strong>${finding.details
                ? html`<p>${finding.details}</p>`
                : nothing}
            </div>
            ${renderSource(finding)}
          </article>`,
      )}
      ${!round.findings.length
        ? html`<div class="review-loop-meta">
            ${loading ? 'Loading recorded findings…' : round.findingsLabel}
          </div>`
        : nothing}
      ${round.diffPath
        ? html`<button
            ?disabled=${loading || (round.diffReconstructed && round.diffText === null)}
            @click=${() => openArtifact(round.diffPath!)}
          >
            ${round.diffReconstructed ? 'Frozen commit diff · reconstructed' : 'Reviewed code diff'}
          </button>`
        : nothing}
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
      ${!loading && round.unavailable.length
        ? html`<details class="history-warning">
            <summary>Some artifacts could not be loaded</summary>
            ${round.unavailable.map((message) => html`<div>${message}</div>`)}
          </details>`
        : nothing}
    </div>
  </details>`;
}

export function renderReviewFix(
  fix: ReviewHistoryFix,
  openArtifact: (path: string) => void,
): unknown {
  const duration =
    fix.durationMs ??
    (fix.running && fix.startedAt ? Date.now() - Date.parse(fix.startedAt) : null);
  return html`<details class="review-history-fix" data-fix=${fix.key}>
    <summary>
      <span class="round-heading"
        ><strong>${fix.label}</strong
        ><span class="chip">${fix.running ? 'Running' : 'Complete'}</span></span
      >
      <span class="round-meta"
        >${fix.range ?? 'Worker applying fixes'}${duration !== null
          ? ` · ${formatDuration(Math.max(0, duration))}`
          : ''}</span
      >
      ${fix.stat ? html`<span class="round-meta">${fix.stat}</span>` : nothing}
    </summary>
    <div class="review-history-body">
      ${fix.reconstructed
        ? html`<span class="chip">Saved head comparison · committed code</span>`
        : nothing}
      ${fix.resolved.length
        ? html`<strong>Not raised again in the later review</strong>${fix.resolved.map(
              (finding) =>
                html`<div class="resolved-finding">
                  <span class="chip severity">${finding.severity}</span> ${finding.title}
                </div>`,
            )}`
        : html`<div class="review-loop-meta">
            ${fix.running
              ? 'Resolution awaits the next review.'
              : 'No per-finding resolution confirmed yet.'}
          </div>`}
      ${fix.files.length
        ? html`<ul class="fix-files">
            ${fix.files.map((file) => html`<li><code>${file}</code></li>`)}
          </ul>`
        : nothing}
      ${fix.diffPath
        ? html`<button
            ?disabled=${Boolean(fix.diffError) || (fix.reconstructed && fix.diffText === null)}
            title=${fix.diffError ?? ''}
            @click=${() => openArtifact(fix.diffPath!)}
          >
            Changed files and diff
          </button>`
        : nothing}
    </div>
  </details>`;
}
