import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';

import {
  type EvidenceReviewClaim,
  type EvidenceReviewModel,
  type EvidenceReviewOccurrence,
  formatEvidenceReviewVideoTime,
} from '@farmslot/adapter-sdk/evidence';

import './media-lightbox.js';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';
import { proofStepGroups } from '../progress-tracker/proof-step-groups.js';

import type { MediaLightbox } from './media-lightbox.js';
import type { LightboxItem } from './media-lightbox-types.js';

/** What the reviewer opens on: one recording and the criterion to start from. */
export interface EvidenceReviewerSelection {
  claimId: string;
  recording: LightboxItem;
}

/**
 * Full-screen review of one recording against the run's acceptance criteria:
 * the criteria as bookmarks on the left, the whole recording on the right.
 * Choosing a criterion jumps to its clips and marks them on the timeline;
 * choosing a step jumps to where it ran and shows what it checked.
 */
@customElement('evidence-video-reviewer')
export class EvidenceVideoReviewer extends LitElement {
  /** The recording, carrying the run's evidence model. */
  @property({ attribute: false }) recording: LightboxItem | null = null;
  @property() claimId = '';
  @state() private openStep: number | null = null;
  /** List criteria in the order the recording reaches them, or by id. */
  @state() private order: 'video' | 'criteria' = 'video';
  @query('media-lightbox') private player?: MediaLightbox;

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      flex-direction: column;
      background: ${unsafeCSS(colors.bgBase)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 12px;
    }
    header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
      padding-top: calc(${unsafeCSS(spacing.sm)} + env(safe-area-inset-top, 0px));
      border-bottom: 1px solid ${unsafeCSS(colors.bgCardHover)};
    }
    header h2 {
      flex: 1;
      margin: 0;
      font-size: 13px;
    }
    .btn {
      min-height: 36px;
      padding: 4px 12px;
      font: inherit;
      color: ${unsafeCSS(colors.textPrimary)};
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 4px;
      cursor: pointer;
    }
    .body {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
    }
    .order {
      display: flex;
      gap: 4px;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
    }
    .order .btn {
      flex: 1;
      color: ${unsafeCSS(colors.textMuted)};
    }
    .order .btn[aria-pressed='true'] {
      color: ${unsafeCSS(colors.textPrimary)};
      border-color: ${unsafeCSS(colors.accent)};
      background: ${unsafeCSS(colors.accent)}22;
    }
    nav {
      overflow: auto;
      border-right: 1px solid ${unsafeCSS(colors.bgCardHover)};
    }
    .claim {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 2px ${unsafeCSS(spacing.sm)};
      width: 100%;
      min-height: 44px;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      font: inherit;
      text-align: left;
      color: ${unsafeCSS(colors.textSecondary)};
      background: transparent;
      border: 0;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
      cursor: pointer;
    }
    .claim[aria-current='true'] {
      color: ${unsafeCSS(colors.textPrimary)};
      background: ${unsafeCSS(colors.accent)}1f;
      box-shadow: inset 3px 0 0 ${unsafeCSS(colors.accent)};
    }
    .claim-id {
      font-weight: 700;
    }
    .claim-text {
      line-height: 1.35;
      max-height: 2.7em;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .muted {
      color: ${unsafeCSS(colors.textMuted)};
    }
    ol {
      list-style: none;
      margin: 0;
      padding: 0 0 ${unsafeCSS(spacing.sm)};
    }
    .step {
      display: grid;
      grid-template-columns: 4.5em 3em minmax(0, 1fr);
      gap: ${unsafeCSS(spacing.sm)};
      width: 100%;
      min-height: 36px;
      padding: 4px ${unsafeCSS(spacing.md)} 4px ${unsafeCSS(spacing.lg)};
      font: inherit;
      text-align: left;
      color: ${unsafeCSS(colors.textSecondary)};
      background: transparent;
      border: 0;
      cursor: pointer;
    }
    .step:hover:not(:disabled),
    .step[aria-expanded='true'] {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .step:disabled {
      cursor: default;
      opacity: 0.6;
    }
    .ok {
      color: ${unsafeCSS(colors.statusOk)};
    }
    .fail {
      color: ${unsafeCSS(colors.statusFail)};
    }
    .detail {
      margin: 0 ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.sm)}
        calc(${unsafeCSS(spacing.lg)} + 4.5em);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: ${unsafeCSS(colors.textMuted)};
    }
    media-lightbox {
      display: block;
      min-height: 0;
    }
    @media (max-width: 760px) {
      .body {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto minmax(0, 40vh);
      }
      nav {
        order: 2;
        border-right: 0;
        border-top: 1px solid ${unsafeCSS(colors.bgCardHover)};
      }
    }
  `;

  private get model(): EvidenceReviewModel | undefined {
    return this.recording?.evidenceModel;
  }

  /** The model's own path for this recording, which its timeline queries take. */
  private get videoPath(): string | undefined {
    const model = this.model;
    const recording = this.recording;
    if (!model || !recording) return undefined;
    return (
      model.recordings.find((entry) => model.artifactPath(entry.videoPath) === recording.path) ??
      model.recordings[0]
    )?.videoPath;
  }

  /** The steps that prove the criterion, the same grouping the proof step list shows. */
  private steps(claim: EvidenceReviewClaim): EvidenceReviewOccurrence[] {
    return (
      proofStepGroups(this.model?.occurrences ?? []).find((group) => group.label === claim.id)
        ?.steps ?? []
    );
  }

  private stepMs(step: EvidenceReviewOccurrence): number | null {
    const path = this.videoPath;
    return path ? (this.model?.markerSeekMs(path, step.traceIndex, 'start') ?? null) : null;
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if ((changed.has('claimId') || changed.has('recording')) && this.claimId)
      this.model?.selectClaim(this.claimId, this.recording?.path);
  }

  /** Where the criterion's first recorded step starts, or null when none is in the recording. */
  private startMs(claim: EvidenceReviewClaim): number | null {
    return (
      this.steps(claim)
        .map((step) => this.stepMs(step))
        .find((ms) => ms !== null) ?? null
    );
  }

  /** Video order: by first recorded step, criteria the recording misses last. */
  private orderedClaims(model: EvidenceReviewModel) {
    const rows = model.claims.map((claim) => ({ claim, start: this.startMs(claim) }));
    return this.order === 'criteria'
      ? rows
      : rows.sort(
          (a, b) => (a.start ?? Number.POSITIVE_INFINITY) - (b.start ?? Number.POSITIVE_INFINITY),
        );
  }

  private chooseClaim(claim: EvidenceReviewClaim) {
    this.openStep = null;
    this.claimId = claim.id;
    this.dispatchEvent(new CustomEvent('reviewer-claim', { detail: { claimId: claim.id } }));
    const start = this.startMs(claim);
    if (start !== null) this.player?.seekToMs(start);
  }

  private chooseStep(step: EvidenceReviewOccurrence, ms: number) {
    this.openStep = this.openStep === step.traceIndex ? null : step.traceIndex;
    this.player?.seekToMs(ms);
  }

  private close() {
    this.dispatchEvent(new CustomEvent('reviewer-close'));
  }

  private renderSteps(claim: EvidenceReviewClaim) {
    const steps = this.steps(claim);
    if (!steps.length)
      return html`<ol>
        <li class="detail">No recorded steps.</li>
      </ol>`;
    return html`<ol>
      ${steps.map((step) => {
        const ms = this.stepMs(step);
        const open = this.openStep === step.traceIndex;
        return html`<li>
          <button
            class="step"
            aria-expanded=${open}
            ?disabled=${ms === null}
            title=${ms === null ? 'Not in the recording' : ''}
            @click=${() => ms !== null && this.chooseStep(step, ms)}
          >
            <span class="muted"
              >${ms === null ? '—' : formatEvidenceReviewVideoTime(ms / 1000, false)}</span
            >
            <span class=${step.ok ? 'ok' : 'fail'}>${step.ok ? 'pass' : 'fail'}</span>
            <span>${step.intent}</span>
          </button>
          ${open
            ? html`<div class="detail">
                ${step.nodeId}${step.expectation
                  ? `\n${Object.entries(step.expectation)
                      .map(
                        ([key, value]) =>
                          `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
                      )
                      .join('\n')}`
                  : ''}
              </div>`
            : nothing}
        </li>`;
      })}
    </ol>`;
  }

  render() {
    const model = this.model;
    if (!model || !this.recording) return nothing;
    const current = model.claims.find((claim) => claim.id === this.claimId);
    return html`
      <header>
        <h2>Evidence review${current ? html` · ${current.id}` : nothing}</h2>
        <button class="btn" @click=${() => this.close()}>Close</button>
      </header>
      <div class="body">
        <nav aria-label="Acceptance criteria">
          <div class="order" role="group" aria-label="Order">
            ${(
              [
                ['video', 'Video order'],
                ['criteria', 'AC order'],
              ] as const
            ).map(
              ([order, label]) =>
                html`<button
                  class="btn"
                  aria-pressed=${this.order === order}
                  @click=${() => (this.order = order)}
                >
                  ${label}
                </button>`,
            )}
          </div>
          ${this.orderedClaims(model).map(({ claim, start }) => {
            const selected = claim.id === this.claimId;
            return html`<button
                class="claim"
                aria-current=${selected}
                @click=${() => this.chooseClaim(claim)}
              >
                <span class="claim-id">${claim.id}</span>
                <span class="claim-text">${claim.text}</span>
                <span class="muted"
                  >${start === null
                    ? 'not recorded'
                    : formatEvidenceReviewVideoTime(start / 1000, false)}</span
                >
              </button>
              ${selected ? this.renderSteps(claim) : nothing}`;
          })}
        </nav>
        <media-lightbox
          embedded
          open
          owns-keys
          hide-timeline
          .confine=${false}
          .items=${[this.recording]}
          .selectedIndex=${0}
          expand-label="All files"
          @lightbox-expand=${() => this.dispatchEvent(new CustomEvent('reviewer-files'))}
          @lightbox-close=${() => this.close()}
        ></media-lightbox>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'evidence-video-reviewer': EvidenceVideoReviewer;
  }
}
