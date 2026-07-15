import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { PRRecommendation, PRStatus } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

function recommendationStyle(rec: PRRecommendation): { bg: string; fg: string; label: string } {
  switch (rec) {
    case 'WORKING':
      return { bg: `${colors.accent}22`, fg: colors.accent, label: 'Working' };
    case 'NEEDS_ATTENTION':
      return { bg: `${colors.statusFail}22`, fg: colors.statusFail, label: 'Needs Attention' };
    case 'IN_REVIEW':
      return { bg: `${colors.statusWarn}22`, fg: colors.statusWarn, label: 'In Review' };
    case 'READY':
      return { bg: `${colors.statusOk}22`, fg: colors.statusOk, label: 'Ready' };
    case 'WAITING_FOR_MERGE':
      return { bg: `#818cf822`, fg: '#818cf8', label: 'Waiting for Merge' };
    case 'MERGED':
      return { bg: `${colors.statusOk}22`, fg: colors.statusOk, label: 'Merged' };
    case 'CLOSED_WITHOUT_MERGE':
      return { bg: `${colors.textMuted}22`, fg: colors.textMuted, label: 'Closed w/o Merge' };
    default:
      return { bg: `${colors.statusUnknown}22`, fg: colors.statusUnknown, label: String(rec) };
  }
}

@customElement('pr-card')
export class PRCard extends LitElement {
  @property({ type: Object }) pr!: PRStatus;
  @property({ type: Boolean }) forceExpanded = false;
  @state() private _expanded = false;

  get _isExpanded() {
    return this._expanded || this.forceExpanded;
  }

  static styles = css`
    :host {
      display: block;
    }

    .card {
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid #1e1e36;
      border-radius: ${unsafeCSS(radii.md)};
      padding: ${unsafeCSS(spacing.lg)};
      cursor: pointer;
      transition:
        border-color 0.15s,
        background 0.15s;
    }

    .card:hover {
      border-color: ${unsafeCSS(colors.accent)}44;
      background: ${unsafeCSS(colors.bgCardHover)};
    }

    .top-row {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
    }

    .pr-number {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      font-weight: 700;
      color: ${unsafeCSS(colors.accent)};
      flex-shrink: 0;
    }

    .pr-title {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textSecondary)};
      white-space: normal;
      overflow-wrap: anywhere;
      line-height: 1.35;
      margin-top: ${unsafeCSS(spacing.sm)};
    }

    .pr-summary {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      margin-top: 2px;
      white-space: normal;
      overflow-wrap: anywhere;
      line-height: 1.4;
    }

    .pr-slot {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      margin-left: auto;
    }
    .family-badge {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
      margin-top: ${unsafeCSS(spacing.sm)};
      display: inline-flex;
      gap: ${unsafeCSS(spacing.sm)};
      flex-wrap: wrap;
    }

    .rec-badge {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 600;
    }

    .ci-bar {
      display: flex;
      height: 4px;
      border-radius: 2px;
      overflow: hidden;
      margin-top: ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.bgInput)};
    }

    .ci-bar-segment {
      height: 100%;
      transition: width 0.3s;
    }

    .ci-summary {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      margin-top: ${unsafeCSS(spacing.sm)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textSecondary)};
    }

    .ci-count {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .ci-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      display: inline-block;
    }

    .bot-count {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.statusWarn)};
      margin-left: auto;
    }

    .actions {
      display: flex;
      gap: ${unsafeCSS(spacing.sm)};
      margin-top: ${unsafeCSS(spacing.md)};
    }

    .action-btn {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border-radius: ${unsafeCSS(radii.sm)};
      border: 1px solid #2a2a44;
      background: ${unsafeCSS(colors.bgInput)};
      color: ${unsafeCSS(colors.textPrimary)};
      cursor: pointer;
      text-decoration: none;
    }

    .action-btn:hover {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .action-btn.primary {
      background: ${unsafeCSS(colors.accent)}22;
      border-color: ${unsafeCSS(colors.accent)}44;
      color: ${unsafeCSS(colors.accent)};
    }

    /* Expanded details */
    .details {
      margin-top: ${unsafeCSS(spacing.lg)};
      border-top: 1px solid #1e1e36;
      padding-top: ${unsafeCSS(spacing.lg)};
    }

    .detail-heading {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: ${unsafeCSS(spacing.sm)};
    }

    .check-list {
      list-style: none;
      padding: 0;
      margin: 0 0 ${unsafeCSS(spacing.lg)} 0;
    }

    .check-item {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: 2px 0;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textSecondary)};
    }

    .check-status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .comment-item {
      padding: ${unsafeCSS(spacing.sm)} 0;
      border-bottom: 1px solid #1e1e3622;
    }

    .comment-author {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.accent)};
      font-weight: 600;
    }

    .comment-body {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textSecondary)};
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }

    .comment-label {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 9px;
      padding: 0 4px;
      border-radius: 2px;
      background: ${unsafeCSS(colors.statusWarn)}22;
      color: ${unsafeCSS(colors.statusWarn)};
      margin-left: ${unsafeCSS(spacing.sm)};
    }
  `;

  private _toggle() {
    this._expanded = !this._expanded;
  }

  private _dispatchFix(e: Event) {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('pr-dispatch-fix', {
        detail: {
          pr: this.pr.pr,
          repo: this.pr.repo,
          project: this.pr.project,
          title: this.pr.title,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _openModal(e: Event) {
    e.stopPropagation();
    if (!this.pr) return;
    this.dispatchEvent(
      new CustomEvent('pr-open-modal', {
        detail: { pr: this.pr.pr, repo: this.pr.repo },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const pr = this.pr;
    if (!pr) return nothing;

    const cs = pr.checkSummary;
    const total = cs.total || 1;
    const all = pr.allCheckSummary;
    const hasAllSummary = Boolean(all && all.total > 0 && all.total !== cs.total);
    const rec = recommendationStyle(pr.recommendation);

    return html`
      <div class="card" @click=${this._toggle}>
        <div class="top-row">
          <span class="pr-number">#${pr.pr}</span>
          <span class="rec-badge" style="background:${rec.bg}; color:${rec.fg}">${rec.label}</span>
          ${pr.slot ? html`<span class="pr-slot">${pr.slot}</span>` : ''}
        </div>
        <div class="pr-title" title="${pr.title}">${pr.title}</div>
        ${pr.summary ? html`<div class="pr-summary">${pr.summary}</div>` : ''}
        ${pr.ownedFamily
          ? html`
              <div class="family-badge">
                ${pr.familyRootTicketOrPr
                  ? html`<span>family root: ${pr.familyRootTicketOrPr}</span>`
                  : nothing}
                ${pr.workflowState ? html`<span>workflow: ${pr.workflowState}</span>` : nothing}
                ${pr.mergeState
                  ? html`<span>merge: ${pr.mergeState.replace(/_/g, ' ')}</span>`
                  : nothing}
              </div>
            `
          : nothing}

        <div class="ci-bar">
          <div
            class="ci-bar-segment"
            style="width:${(cs.passed / total) * 100}%; background:${colors.statusOk}"
          ></div>
          <div
            class="ci-bar-segment"
            style="width:${(cs.failed / total) * 100}%; background:${colors.statusFail}"
          ></div>
          <div
            class="ci-bar-segment"
            style="width:${(cs.pending / total) * 100}%; background:${colors.statusWarn}"
          ></div>
        </div>

        <div class="ci-summary">
          <span class="ci-count"
            ><span class="ci-dot" style="background:${colors.statusOk}"></span> ${cs.passed}</span
          >
          <span class="ci-count"
            ><span class="ci-dot" style="background:${colors.statusFail}"></span> ${cs.failed}</span
          >
          <span class="ci-count"
            ><span class="ci-dot" style="background:${colors.statusWarn}"></span>
            ${cs.pending}</span
          >
          <span style="color:${colors.textMuted}">/ ${cs.total} watched</span>
          ${pr.botComments.length > 0
            ? html`
                <span class="bot-count"
                  >${pr.botComments.length} comment${pr.botComments.length !== 1 ? 's' : ''}</span
                >
              `
            : ''}
        </div>
        ${hasAllSummary && all
          ? html`
              <div class="ci-summary" style="margin-top:2px; color:${colors.textMuted}">
                <span>GitHub total:</span>
                <span class="ci-count"
                  ><span class="ci-dot" style="background:${colors.statusOk}"></span>
                  ${all.passed}</span
                >
                <span class="ci-count"
                  ><span class="ci-dot" style="background:${colors.statusFail}"></span>
                  ${all.failed}</span
                >
                <span class="ci-count"
                  ><span class="ci-dot" style="background:${colors.statusWarn}"></span>
                  ${all.pending}</span
                >
                ${all.skipped ? html`<span>${all.skipped} skipped</span>` : nothing}
                <span>/ ${all.total}</span>
              </div>
            `
          : nothing}

        <div class="actions">
          <button class="action-btn" @click=${this._openModal} title="Open full-size detail">
            Expand
          </button>
          <a
            class="action-btn"
            href="https://github.com/${pr.repo}/pull/${pr.pr}"
            target="_blank"
            @click=${(e: Event) => e.stopPropagation()}
            >View PR</a
          >
          ${pr.familyId
            ? html`
                <a
                  class="action-btn"
                  href="#runs?family=${encodeURIComponent(pr.familyId)}"
                  @click=${(e: Event) => e.stopPropagation()}
                  >View Family</a
                >
              `
            : nothing}
          ${pr.recommendation === 'READY' || pr.recommendation === 'WAITING_FOR_MERGE'
            ? html`
                <a
                  class="action-btn primary"
                  href="https://github.com/${pr.repo}/pull/${pr.pr}"
                  target="_blank"
                  @click=${(e: Event) => e.stopPropagation()}
                  >Merge</a
                >
              `
            : ''}
          ${pr.recommendation === 'NEEDS_ATTENTION'
            ? html`
                <button
                  class="action-btn primary"
                  @click=${this._dispatchFix}
                  title="Runs the pr-complete flow on this PR"
                >
                  Complete PR
                </button>
              `
            : ''}
        </div>

        ${this._isExpanded
          ? html`
              <div class="details">
                <div class="detail-heading">Watched CI Checks</div>
                <ul class="check-list">
                  ${pr.checks.map(
                    (c) => html`
                      <li class="check-item">
                        <span
                          class="check-status"
                          style="background:${c.status === 'pass'
                            ? colors.statusOk
                            : c.status === 'fail'
                              ? colors.statusFail
                              : c.status === 'skipped'
                                ? colors.statusUnknown
                                : colors.statusWarn}"
                        ></span>
                        <span>${c.name}</span>
                      </li>
                    `,
                  )}
                </ul>
                ${hasAllSummary && all
                  ? html`
                      <div class="detail-heading">All GitHub Checks</div>
                      <div
                        style="font-family:${fonts.mono}; font-size:${fonts.sizeXs}; color:${colors.textMuted}; line-height:1.5"
                      >
                        ${all.passed} passed · ${all.failed} failed · ${all.pending}
                        pending${all.skipped ? ` · ${all.skipped} skipped` : ''} · ${all.total}
                        total
                      </div>
                      ${(pr.allPendingNames?.length ?? 0) > 0
                        ? html`
                            <div
                              style="font-family:${fonts.mono}; font-size:${fonts.sizeXs}; color:${colors.statusWarn}; margin-top:4px"
                            >
                              Pending: ${pr.allPendingNames!.join(', ')}
                            </div>
                          `
                        : nothing}
                      ${(pr.allFailedNames?.length ?? 0) > 0
                        ? html`
                            <div
                              style="font-family:${fonts.mono}; font-size:${fonts.sizeXs}; color:${colors.statusFail}; margin-top:4px"
                            >
                              Failed: ${pr.allFailedNames!.join(', ')}
                            </div>
                          `
                        : nothing}
                    `
                  : nothing}
                ${pr.botComments.length > 0
                  ? html`
                      <div class="detail-heading">Bot Comments</div>
                      ${pr.botComments.map(
                        (c) => html`
                          <div class="comment-item">
                            <span class="comment-author">${c.author}</span>
                            <span class="comment-label">${c.label}</span>
                            <div class="comment-body">${c.bodyPreview}</div>
                          </div>
                        `,
                      )}
                    `
                  : ''}
                ${pr.failedNames.length > 0
                  ? html`
                      <div class="detail-heading">Failed Checks</div>
                      <ul class="check-list">
                        ${pr.failedNames.map(
                          (name) => html`
                            <li class="check-item">
                              <span
                                class="check-status"
                                style="background:${colors.statusFail}"
                              ></span>
                              <span>${name}</span>
                            </li>
                          `,
                        )}
                      </ul>
                    `
                  : ''}
              </div>
            `
          : ''}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pr-card': PRCard;
  }
}
