import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  ArtifactRef,
  IndependentReviewAttempt,
  IndependentReviewStatus,
  ReviewDiffSnapshot,
  ReviewFixDeltaSnapshot,
  RunnerSessionUsage,
} from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { gatewayHttpFetch } from '../../utils/gateway-origin.js';
import {
  fixDeltaAbsenceReason,
  hasMeaningfulReviewFixDelta,
  reviewAttemptLabel,
  reviewHasPendingContinuationPhases,
  reviewPolicyLabel,
  reviewSourceLabel,
} from '../../utils/review-gate-display.js';

export interface ReviewLoopArtifactOpenDetail {
  artifact: ArtifactRef;
  artifacts: ArtifactRef[];
  loopNumber: number;
  label: string;
}

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 7) : 'unknown';
}

function snapshotDiffArtifact(
  snapshot: ReviewDiffSnapshot | undefined,
  purpose: string,
): ArtifactRef | null {
  return snapshot?.diffPath ? { path: snapshot.diffPath, purpose } : null;
}

function issueAttemptCount(review: IndependentReviewStatus): number {
  return (review.attempts ?? []).reduce((sum, attempt) => sum + (attempt.issues?.length ?? 0), 0);
}

function formatRunnerUsage(usage: RunnerSessionUsage | undefined): string {
  if (!usage) return 'usage pending';
  if (usage.source === 'unavailable') return 'usage unavailable';
  const parts = [
    usage.turns != null ? `${usage.turns} turns` : null,
    usage.totalTokens != null ? `${usage.totalTokens.toLocaleString()} tok` : null,
    usage.costUsd != null ? `$${usage.costUsd.toFixed(4)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'usage measured';
}

function reviewUsage(review: IndependentReviewStatus) {
  return review.usage ?? review.attempts?.at(-1)?.usage;
}

function reviewDisplayLabel(review: IndependentReviewStatus): string {
  return reviewSourceLabel(review);
}

function fixDeltaRange(delta: ReviewFixDeltaSnapshot | undefined) {
  return {
    base: delta?.fixBaseSha ?? delta?.baseSha,
    head: delta?.fixHeadSha ?? delta?.headSha,
  };
}

function formatFixDeltaStat(delta: ReviewFixDeltaSnapshot | undefined): string | null {
  if (!delta?.diffStat) return null;
  const untracked = delta.untrackedFiles?.length ?? 0;
  const tracked = Math.max(0, delta.diffStat.files - untracked);
  const paths = untracked
    ? `${tracked} tracked + ${untracked} untracked`
    : `${delta.diffStat.files} file${delta.diffStat.files === 1 ? '' : 's'}`;
  return `${paths} · +${delta.diffStat.additions} −${delta.diffStat.deletions}`;
}

function reviewAttemptHeading(
  review: IndependentReviewStatus,
  attemptIndex: number,
  attemptCount: number,
): string {
  return reviewAttemptLabel(review, attemptIndex, attemptCount);
}

type ParsedIssue = { file: string; line?: number; description: string };
type LegacyIssueLoad =
  | { status: 'loading' }
  | { status: 'ok'; issues: ParsedIssue[] }
  | { status: 'error'; message: string };

function parseReviewFeedbackIssues(markdown: string): ParsedIssue[] {
  const issues: ParsedIssue[] = [];
  const seen = new Set<string>();
  const issueRegex = /[-*]\s+(?:\*\*([^*]+)\*\*|`([^`]+)`)\s*[—–-]\s*(.*)/g;
  let match: RegExpExecArray | null;
  while ((match = issueRegex.exec(markdown)) !== null) {
    const loc = (match[1] ?? match[2] ?? '').trim();
    const description = match[3]?.trim();
    if (!loc || !description) continue;
    const lineMatch = loc.match(/^(.*):(\d+)$/);
    const file = lineMatch?.[1] ?? loc;
    const line = lineMatch?.[2] ? Number(lineMatch[2]) : undefined;
    const key = `${file}:${line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ file, line, description });
  }
  return issues;
}

@customElement('review-loop-timeline')
export class ReviewLoopTimeline extends LitElement {
  @property({ attribute: false }) reviews: IndependentReviewStatus[] = [];
  @property({ type: Boolean }) compact = false;
  @property({ attribute: false }) artifactUrl?: (artifact: ArtifactRef) => string;

  @state() private _legacyIssueVersion = 0;
  private _legacyIssues = new Map<string, LegacyIssueLoad>();

  static styles = css`
    :host {
      display: block;
      font-family: ${unsafeCSS(fonts.mono)};
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .timeline {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.sm)};
    }
    .review-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .reviewer-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.sm)};
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .reviewer-head strong {
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .phase-strip {
      display: flex;
      align-items: stretch;
      gap: 4px;
      overflow-x: auto;
      padding: 1px;
    }
    .phase {
      min-width: 112px;
      flex: 1 0 auto;
      border: 1px solid ${unsafeCSS(colors.textMuted)}44;
      border-radius: ${unsafeCSS(radii.sm)};
      padding: 5px 7px;
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .phase::after {
      content: '\\2192';
      color: ${unsafeCSS(colors.textMuted)};
      margin-left: 8px;
    }
    .phase:last-child::after {
      content: '';
      margin: 0;
    }
    .phase.pass {
      border-color: ${unsafeCSS(colors.statusOk)}66;
    }
    .phase.warn,
    .phase.no-change {
      border-color: ${unsafeCSS(colors.statusWarn)}77;
    }
    .phase.pending {
      border-style: dashed;
      color: ${unsafeCSS(colors.textMuted)};
    }
    .phase-title {
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
      margin-right: 5px;
    }
    .empty {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      border: 1px dashed ${unsafeCSS(colors.textMuted)}55;
      border-radius: ${unsafeCSS(radii.md)};
      padding: ${unsafeCSS(spacing.sm)};
    }
    .card {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgCard)};
      padding: ${unsafeCSS(spacing.sm)};
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .card.pass {
      border-color: ${unsafeCSS(colors.statusOk)}55;
    }
    .card.warn {
      border-color: ${unsafeCSS(colors.statusWarn)}88;
      background: ${unsafeCSS(colors.statusWarn)}0d;
    }
    .head,
    .meta-row,
    .artifact-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .head {
      justify-content: space-between;
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .head strong {
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .pill {
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid ${unsafeCSS(colors.textMuted)}55;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .pill.pass {
      border-color: ${unsafeCSS(colors.statusOk)}77;
      color: ${unsafeCSS(colors.statusOk)};
    }
    .pill.warn {
      border-color: ${unsafeCSS(colors.statusWarn)}88;
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .meta {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .issues {
      margin: 0;
      padding-left: 18px;
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .issue-file {
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .section-label {
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .fix {
      border-left: 2px solid ${unsafeCSS(colors.accent)}88;
      padding-left: 8px;
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    button.link {
      font-family: inherit;
      border: 1px solid ${unsafeCSS(colors.textMuted)}44;
      border-radius: ${unsafeCSS(radii.sm)};
      background: transparent;
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: 10px;
      padding: 2px 6px;
      cursor: pointer;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    button.link:hover {
      border-color: ${unsafeCSS(colors.accent)}88;
      color: ${unsafeCSS(colors.accent)};
      background: ${unsafeCSS(colors.accent)}14;
    }
  `;

  override render() {
    if (!this.reviews.length) {
      return html`<div class="empty">Independent review pending</div>`;
    }
    return html`
      <div class="timeline" aria-label="Review loop results">
        ${this.reviews.map((review, index) => this._renderReviewRows(review, index))}
      </div>
    `;
  }

  private _renderReviewRows(review: IndependentReviewStatus, reviewIndex: number) {
    const attempts = review.attempts ?? [];
    return html`
      <div class="review-group">
        <div class="reviewer-head">
          <strong>${review.runner ?? 'Unknown runner'} / ${review.model ?? 'default'}</strong>
          <span>Check ${reviewIndex + 1} · ${reviewDisplayLabel(review)}</span>
        </div>
        ${this._renderPhaseStrip(review, attempts)}
        ${attempts.length > 1
          ? attempts.map((attempt, index) =>
              this._renderReview(review, attempt, index, attempts.length),
            )
          : this._renderReview(review, attempts[0], 0, Math.max(1, attempts.length))}
      </div>
    `;
  }

  private _renderPhaseStrip(review: IndependentReviewStatus, attempts: IndependentReviewAttempt[]) {
    if (!attempts.length) return nothing;
    const phases = attempts.flatMap((attempt, index) => {
      const pass = attempt.verdict === 'pass' && attempt.unresolvedCount === 0;
      const warn =
        attempt.unresolvedCount > 0 || attempt.verdict === 'issues' || attempt.verdict === 'failed';
      const reviewRound = index + 1;
      const reviewPhase = html`
        <div class="phase ${pass ? 'pass' : warn ? 'warn' : ''}">
          <span class="phase-title">Review round ${reviewRound}</span>
          ${pass
            ? 'passed'
            : attempt.verdict === 'failed'
              ? 'did not run'
              : warn
                ? `${attempt.unresolvedCount} finding(s)`
                : attempt.verdict}
        </div>
      `;
      if (index === 0) return [reviewPhase];
      const delta = attempt.fixDelta;
      const meaningful = hasMeaningfulReviewFixDelta(delta);
      const deltaStat = formatFixDeltaStat(delta);
      const { base, head } = fixDeltaRange(delta);
      const fixPhase = html`
        <div class="phase ${meaningful ? '' : 'no-change'}">
          <span class="phase-title">Fix after review round ${index}</span>
          ${meaningful
            ? `${deltaStat ? `${deltaStat} · ` : ''}${shortSha(base)}..${shortSha(head)}`
            : 'no tracked change'}
        </div>
      `;
      return [fixPhase, reviewPhase];
    });
    if (reviewHasPendingContinuationPhases(review, attempts.at(-1))) {
      phases.push(
        html`<div class="phase pending">
          <span class="phase-title">Next fix</span>pending delivery
        </div>`,
        html`<div class="phase pending">
          <span class="phase-title">Next review round</span>waits for fix
        </div>`,
      );
    }
    return html`
      <div class="phase-strip" aria-label="${reviewDisplayLabel(review)} resolution sequence">
        ${phases}
      </div>
    `;
  }

  private _renderReview(
    review: IndependentReviewStatus,
    attempt?: IndependentReviewAttempt,
    attemptIndex = 0,
    attemptCount = 1,
  ) {
    void this._legacyIssueVersion;
    const loopNumber = attempt?.loopNumber ?? review.loopNumber;
    const verdict = attempt?.verdict ?? review.verdict;
    const unresolvedCount = attempt?.unresolvedCount ?? review.unresolvedCount;
    const issues = attempt ? attempt.issues : review.issues;
    const failureReason = attempt?.reason ?? review.reason;
    const validationDepth = attempt?.validationDepth ?? review.validationDepth;
    const rowSnapshot = attempt ? attempt.reviewSnapshot : review.reviewSnapshot;
    const rowFixDelta = attempt ? attempt.fixDelta : review.fixDelta;
    const hasFixDeltaRange = hasMeaningfulReviewFixDelta(rowFixDelta);
    const fixDeltaMissingReason = hasFixDeltaRange ? '' : fixDeltaAbsenceReason(review, attempt);
    const rowUsage = attempt ? attempt.usage : reviewUsage(review);
    const pass = verdict === 'pass' && unresolvedCount === 0;
    const warn = unresolvedCount > 0 || verdict === 'issues' || verdict === 'failed';
    const diffArtifact = snapshotDiffArtifact(rowSnapshot, `review-loop-${loopNumber}-input-diff`);
    const fixDeltaArtifact = snapshotDiffArtifact(
      rowFixDelta,
      `review-loop-${loopNumber}-fix-delta`,
    );
    const artifacts: ArtifactRef[] = (
      attempt ? (attempt.artifactPaths ?? []) : (review.artifactPaths ?? [])
    ).map((path) => ({
      path,
      purpose: `review-loop-${loopNumber}`,
    }));
    const priorIssueAttempts = attempt
      ? []
      : (review.attempts ?? []).filter((entry) => entry.issues?.length);
    if (
      warn &&
      !issues?.length &&
      !artifacts.some((artifact) => artifact.path.endsWith('review-feedback.md'))
    ) {
      artifacts.push({
        path: 'artifacts/review-feedback.md',
        purpose: `review-loop-${loopNumber}-latest-feedback`,
      });
    }
    const legacyIssues = this._legacyIssueLoad(review, artifacts, {
      issues,
      loopNumber,
      unresolvedCount,
    });
    const visibleArtifacts = this.compact ? artifacts.slice(0, 4) : artifacts;
    const label = reviewDisplayLabel(review);
    const heading = reviewAttemptHeading(review, attemptIndex, attemptCount);
    return html`
      <section class="card ${pass ? 'pass' : warn ? 'warn' : ''}">
        <div class="head">
          <strong>${heading}</strong>
          <span class="pill ${pass ? 'pass' : warn ? 'warn' : ''}"
            >${verdict}${reviewPolicyLabel(review)
              ? ` \u00b7 ${reviewPolicyLabel(review)}`
              : ''}</span
          >
        </div>
        <div class="meta-row">
          <span class="meta"
            >${review.runner ?? 'reviewer'} / ${review.model ?? 'model unknown'}</span
          >
          <span class="meta">${label}</span>
          <span class="meta">review round ${attemptIndex + 1}</span>
          <span class="meta">${validationDepth ?? 'legacy/full-live'}</span>
          <span class="meta">${unresolvedCount} unresolved</span>
          <span class="meta" title=${rowUsage?.runnerSessionId ?? review.reviewerSessionId ?? ''}
            >${formatRunnerUsage(rowUsage)}</span
          >
          <span class="meta">${artifacts.length} artifacts</span>
          <span class="meta">reviewed ${shortSha(rowSnapshot?.headSha)}</span>
          ${diffArtifact
            ? html`<button
                class="link"
                @click=${() => this._emitDiff(diffArtifact, review, artifacts, loopNumber)}
              >
                review diff
              </button>`
            : nothing}
        </div>
        ${issues?.length
          ? html`
              <div class="section-label">Findings · ${issues.length}</div>
              <ul class="issues">
                ${issues.map(
                  (issue) => html`
                    <li>
                      <span class="issue-file"
                        >${issue.file}${issue.line ? `:${issue.line}` : ''}</span
                      >
                      — ${issue.description}
                    </li>
                  `,
                )}
              </ul>
            `
          : !warn && priorIssueAttempts.length
            ? html`
                <div class="meta">
                  Found ${issueAttemptCount(review)} issue(s), fed back to worker, final re-review
                  passed.
                </div>
                <ul class="issues">
                  ${priorIssueAttempts.flatMap((attempt) =>
                    (attempt.issues ?? []).map(
                      (issue) => html`
                        <li>
                          <span class="issue-file"
                            >${issue.file}${issue.line ? `:${issue.line}` : ''}</span
                          >
                          — ${issue.description}
                        </li>
                      `,
                    ),
                  )}
                </ul>
              `
            : failureReason
              ? html`<div class="meta attention">${failureReason}</div>`
              : unresolvedCount > 0
                ? this._renderLegacyIssues(legacyIssues)
                : nothing}
        ${unresolvedCount > 0 &&
        !issues?.length &&
        artifacts.some((artifact) => artifact.path.endsWith('review-feedback.md'))
          ? html`
              <div class="meta-row">
                <button
                  class="link"
                  @click=${() => {
                    const feedback = artifacts.find((artifact) =>
                      artifact.path.endsWith('review-feedback.md'),
                    )!;
                    this._emitArtifact(feedback, review, artifacts, loopNumber);
                  }}
                >
                  open review feedback
                </button>
              </div>
            `
          : nothing}
        ${rowFixDelta && hasFixDeltaRange
          ? html`
              <div class="fix">
                <span class="section-label">Worker fix</span>
                ${shortSha(rowFixDelta.fixBaseSha ?? rowFixDelta.baseSha)}..${shortSha(
                  rowFixDelta.fixHeadSha ?? rowFixDelta.headSha,
                )}
                ${fixDeltaArtifact
                  ? html`<button
                      class="link"
                      @click=${() =>
                        this._emitDiff(fixDeltaArtifact, review, artifacts, loopNumber)}
                    >
                      open fix diff
                    </button>`
                  : nothing}
              </div>
            `
          : fixDeltaMissingReason
            ? html`<div class="meta">${fixDeltaMissingReason}</div>`
            : nothing}
        ${visibleArtifacts.length
          ? html`
              <div class="artifact-row">
                ${visibleArtifacts.map(
                  (artifact) => html`
                    <button
                      class="link"
                      title=${artifact.path}
                      @click=${() => this._emitArtifact(artifact, review, artifacts, loopNumber)}
                    >
                      ${artifact.path.split('/').pop()}
                    </button>
                  `,
                )}
                ${artifacts.length > visibleArtifacts.length
                  ? html`<span class="meta"
                      >+${artifacts.length - visibleArtifacts.length} more</span
                    >`
                  : nothing}
              </div>
            `
          : nothing}
      </section>
    `;
  }

  private _legacyIssueLoad(
    review: IndependentReviewStatus,
    artifacts: ArtifactRef[],
    row: {
      issues?: IndependentReviewAttempt['issues'];
      loopNumber: number;
      unresolvedCount: number;
    },
  ): LegacyIssueLoad | null {
    if (row.issues?.length || row.unresolvedCount <= 0 || !this.artifactUrl) return null;
    const feedback = artifacts.find((artifact) => artifact.path.endsWith('review-feedback.md'));
    if (!feedback) return null;
    const key = `${review.id}:${row.loopNumber}:${feedback.path}`;
    const existing = this._legacyIssues.get(key);
    if (existing) return existing;
    this._legacyIssues.set(key, { status: 'loading' });
    gatewayHttpFetch(this.artifactUrl(feedback))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => {
        this._legacyIssues.set(key, { status: 'ok', issues: parseReviewFeedbackIssues(text) });
        this._legacyIssueVersion += 1;
      })
      .catch((error: Error) => {
        this._legacyIssues.set(key, { status: 'error', message: error.message });
        this._legacyIssueVersion += 1;
      });
    return { status: 'loading' };
  }

  private _renderLegacyIssues(load: LegacyIssueLoad | null) {
    if (!load)
      return html`<div class="meta">
        Issue details were not persisted for this legacy loop. Open the review feedback artifact if
        available.
      </div>`;
    if (load.status === 'loading')
      return html`<div class="meta">Loading review finding details…</div>`;
    if (load.status === 'error')
      return html`<div class="meta">
        Issue details could not be loaded from review feedback: ${load.message}
      </div>`;
    if (!load.issues.length)
      return html`<div class="meta">
        Issue details were not found in the review feedback artifact.
      </div>`;
    return html`
      <ul class="issues">
        ${load.issues.map(
          (issue) => html`
            <li>
              <span class="issue-file">${issue.file}${issue.line ? `:${issue.line}` : ''}</span>
              — ${issue.description}
            </li>
          `,
        )}
      </ul>
    `;
  }

  private _emitArtifact(
    artifact: ArtifactRef,
    review: IndependentReviewStatus,
    artifacts: ArtifactRef[],
    loopNumber: number,
  ) {
    this.dispatchEvent(
      new CustomEvent('review-artifact-open', {
        detail: {
          artifact,
          artifacts,
          loopNumber,
          label: `${reviewDisplayLabel(review)} artifact loop ${loopNumber}`,
        } satisfies ReviewLoopArtifactOpenDetail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _emitDiff(
    artifact: ArtifactRef,
    review: IndependentReviewStatus,
    artifacts: ArtifactRef[],
    loopNumber: number,
  ) {
    this.dispatchEvent(
      new CustomEvent('review-diff-open', {
        detail: {
          artifact,
          artifacts,
          loopNumber,
          label: `${reviewDisplayLabel(review)} artifact loop ${loopNumber}`,
        } satisfies ReviewLoopArtifactOpenDetail,
        bubbles: true,
        composed: true,
      }),
    );
  }
}
