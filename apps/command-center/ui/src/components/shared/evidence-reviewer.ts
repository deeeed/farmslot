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
import {
  formatProofStepExpectation,
  proofStepGroups,
} from '../progress-tracker/proof-step-groups.js';
import { workspaceArtifactBasename } from '../workspace/workspace-artifacts.js';

import { gatewayMediaSrc } from './gateway-media-src.js';
import type { MediaLightbox } from './media-lightbox.js';
import { isVideoLightboxItem } from './media-lightbox-model.js';
import type { LightboxItem } from './media-lightbox-types.js';

/** What the review opens on: a criterion, its run's evidence, and the file the user chose. */
export interface EvidenceReviewerSelection {
  claimId: string;
  model: EvidenceReviewModel;
  /** The run's recording, when the criterion has one. */
  recording: LightboxItem | null;
  /** Serves a criterion's evidence file. */
  resolveUrl: (path: string) => string;
  /** The file the review was opened from: anything but the recording opens on itself. */
  opened?: LightboxItem;
}

/**
 * The review for one criterion of a run: its recording (the opened one, else the
 * run's first) and the file the user chose. Every host opens the review through this.
 */
export function evidenceReviewerSelection(input: {
  model: EvidenceReviewModel;
  claimId: string;
  resolveUrl: (path: string) => string;
  opened?: LightboxItem;
}): EvidenceReviewerSelection {
  const { model, resolveUrl, opened } = input;
  const timeline = model.recordings[0];
  const path = timeline ? model.artifactPath(timeline.videoPath) : null;
  const recording =
    opened && isVideoLightboxItem(opened)
      ? opened
      : path
        ? {
            url: resolveUrl(path),
            path,
            purpose: 'recording',
            evidenceModel: model,
            resolveArtifactUrl: resolveUrl,
          }
        : null;
  return { claimId: input.claimId, model, recording, resolveUrl, opened };
}

/**
 * Full-screen review of a run's evidence against its acceptance criteria: the
 * criteria on the left, each with its proof steps and screenshots; the chosen
 * moment of the recording, or the chosen screenshot, in the main view.
 */
@customElement('evidence-reviewer')
export class EvidenceReviewer extends LitElement {
  @property({ attribute: false }) selection: EvidenceReviewerSelection | null = null;
  /** Shown in the page instead of over it; Full screen lifts it over the page. */
  @property({ type: Boolean, reflect: true }) inline = false;
  @property({ type: Boolean, reflect: true }) expanded = false;
  @state() private claimId = '';
  @state() private openStep: number | null = null;
  /** List criteria in the order the recording reaches them, or by id. */
  @state() private order: 'video' | 'criteria' = 'video';
  /** The screenshot in the main view instead of the recording. */
  @state() private still: LightboxItem | null = null;
  @query('media-lightbox') private player?: MediaLightbox;

  static styles = css`
    :host([inline]:not([expanded])) {
      position: relative;
      inset: auto;
      z-index: auto;
      height: min(78vh, 900px);
      margin: ${unsafeCSS(spacing.sm)} 0;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 6px;
      overflow: hidden;
    }
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
    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      color: ${unsafeCSS(colors.textMuted)};
    }
    .stills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 0 ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
    }
    .still {
      width: 72px;
      height: 54px;
      padding: 0;
      overflow: hidden;
      background: #000;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 3px;
      cursor: pointer;
    }
    .still-video {
      display: flex;
      align-items: center;
      justify-content: center;
      color: ${unsafeCSS(colors.textSecondary)};
      font: inherit;
    }
    .still[aria-pressed='true'] {
      border-color: ${unsafeCSS(colors.accent)};
    }
    .still img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    @media (pointer: coarse) {
      .btn,
      .step,
      .claim {
        min-height: 44px;
      }
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
    return this.selection?.model;
  }

  private get recording(): LightboxItem | null {
    const selection = this.selection;
    if (!selection?.recording) return null;
    return {
      ...selection.recording,
      // The host's current model: a live run replaces it, and the item may carry an older one.
      evidenceModel: selection.model,
    };
  }

  /** The model's own path for the recording, which its timeline queries take. */
  private get videoPath(): string | undefined {
    const model = this.model;
    const recording = this.selection?.recording;
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

  /** The criterion's screenshots, served like the rest of its evidence. */
  private stills(claim: EvidenceReviewClaim): LightboxItem[] {
    const resolve = this.selection?.resolveUrl;
    if (!resolve) return [];
    return claim.evidence
      .filter((artifact) => artifact.mediaType === 'image')
      .map((artifact) => ({
        url: resolve(artifact.artifactPath),
        path: artifact.artifactPath,
        purpose: 'screenshot',
      }));
  }

  /** Where the criterion's first recorded step starts, or null when none is in the recording. */
  private startMs(claim: EvidenceReviewClaim): number | null {
    return (
      this.steps(claim)
        .map((step) => this.stepMs(step))
        .find((ms) => ms !== null) ?? null
    );
  }

  private claimStartMs(): number | null {
    const claim = this.claim();
    return claim ? this.startMs(claim) : null;
  }

  private claim(): EvidenceReviewClaim | undefined {
    return this.model?.claims.find((candidate) => candidate.id === this.claimId);
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

  /** The selection last applied; host re-renders that keep it change nothing. */
  private applied?: EvidenceReviewerSelection;
  private appliedClaim = '';
  private appliedModel?: EvidenceReviewModel;
  /** Where the recording should be once it shows: a criterion start, a step, or a resume point. */
  private pendingSeekMs: number | null = null;
  private resumeMs: number | null = null;

  protected willUpdate(changed: Map<string, unknown>): void {
    const selection = this.selection;
    if (!selection) return;
    const reopened =
      changed.has('selection') &&
      (selection.claimId !== this.applied?.claimId ||
        selection.recording?.url !== this.applied?.recording?.url ||
        selection.opened?.path !== this.applied?.opened?.path);
    this.applied = selection;
    if (reopened) this.claimId = selection.claimId;
    const claimChanged = this.claimId !== this.appliedClaim;
    if (!claimChanged && selection.model === this.appliedModel) return;
    this.appliedClaim = this.claimId;
    this.appliedModel = selection.model;
    // A criterion whose own files do not list the recording still marks it by its steps;
    // never leave the previous criterion's clips on the timeline.
    const model = selection.model;
    if (
      this.claimId &&
      !(selection.recording && model.selectClaim(this.claimId, selection.recording.path)) &&
      !model.selectClaim(this.claimId)
    )
      model.clearSelection();
    if (!claimChanged && !reopened) return;
    // A refreshed evidence model keeps what is on screen; a new criterion or file starts over.
    const claim = this.claim();
    const opened =
      reopened && selection.opened && !isVideoLightboxItem(selection.opened)
        ? selection.opened
        : undefined;
    this.openStep = null;
    this.resumeMs = null;
    const start = claim ? this.startMs(claim) : null;
    // Choosing a criterion shows its proof: the recording at its first step, or its
    // first screenshot when the recording does not cover it.
    if (opened || !this.recording || (start === null && claim && this.stills(claim).length)) {
      this.still = opened ?? (claim ? (this.stills(claim)[0] ?? null) : null);
      this.pendingSeekMs = null;
    } else {
      this.still = null;
      this.pendingSeekMs = this.openedMomentMs(reopened) ?? start;
    }
  }

  /** A recording opened at a step (a moment link) starts there, not at the criterion start. */
  private openedMomentMs(reopened: boolean): number | null {
    const opened = this.selection?.opened;
    const path = this.videoPath;
    if (!reopened || !opened || opened.initialTraceIndex === undefined || !path) return null;
    return (
      this.model?.markerSeekMs(
        path,
        opened.initialTraceIndex,
        opened.initialTracePhase ?? 'start',
      ) ?? null
    );
  }

  protected updated(): void {
    if (this.still || this.pendingSeekMs === null) return;
    const ms = this.pendingSeekMs;
    this.pendingSeekMs = null;
    this.player?.seekToMs(ms);
  }

  private playerItems(): LightboxItem[] {
    const item = this.still ?? this.recording;
    if (!item) return [];
    // Same file and model, same array: the player keeps its video element and timeline.
    if (this.cachedItems?.[0]?.url !== item.url || this.cachedModel !== this.model)
      this.cachedItems = [item];
    this.cachedModel = this.model;
    return this.cachedItems;
  }

  private cachedItems?: LightboxItem[];
  private cachedModel?: EvidenceReviewModel;

  private chooseClaim(claim: EvidenceReviewClaim) {
    this.claimId = claim.id;
    this.dispatchEvent(new CustomEvent('reviewer-claim', { detail: { claimId: claim.id } }));
  }

  private chooseStep(step: EvidenceReviewOccurrence, ms: number) {
    this.openStep = this.openStep === step.traceIndex ? null : step.traceIndex;
    this.showVideo(ms);
  }

  private showStill(item: LightboxItem) {
    if (!this.still) this.resumeMs = this.player?.currentTimeMs() ?? null;
    this.still = item;
  }

  /** Back to the recording: at the given moment, where it was, or at the criterion's start. */
  private showVideo(ms: number | null = this.resumeMs ?? this.claimStartMs()) {
    if (this.still) this.still = null;
    if (ms === null) return;
    if (this.player?.currentTimeMs() != null) this.player.seekToMs(ms);
    else this.pendingSeekMs = ms;
  }

  /** The criterion's files in the host gallery; an in-page review steps out of its way. */
  private showFiles() {
    if (this.inline) this.expanded = false;
    this.dispatchEvent(new CustomEvent('reviewer-files', { detail: { claimId: this.claimId } }));
  }

  /** Escape still leaves when no player is shown to take it (a criterion without media). */
  private onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || this.player || (this.inline && !this.expanded)) return;
    event.preventDefault();
    this.close();
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKey);
  }

  private close() {
    if (this.inline) {
      this.expanded = false;
      return;
    }
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
                  ? `\n${formatProofStepExpectation(step.expectation)}`
                  : ''}
              </div>`
            : nothing}
        </li>`;
      })}
    </ol>`;
  }

  /** The recording and the criterion's screenshots, one tap each into the main view. */
  private renderMedia(claim: EvidenceReviewClaim) {
    const stills = this.stills(claim);
    if (!stills.length) return nothing;
    return html`<div class="stills" role="group" aria-label="Evidence">
      ${this.recording
        ? html`<button
            class="still still-video"
            aria-pressed=${!this.still}
            title="Recording"
            @click=${() => this.showVideo()}
          >
            Video
          </button>`
        : nothing}
      ${stills.map(
        (item) =>
          html`<button
            class="still"
            aria-pressed=${this.still?.path === item.path}
            title=${item.path}
            @click=${() => this.showStill(item)}
          >
            <img src=${gatewayMediaSrc(item.url)} alt=${workspaceArtifactBasename(item.path)} />
          </button>`,
      )}
    </div>`;
  }

  render() {
    const model = this.model;
    if (!model || !this.selection) return nothing;
    const current = this.claim();
    const items = this.playerItems();
    return html`
      <header>
        <h2>Evidence review${current ? html` · ${current.id}` : nothing}</h2>
        ${this.inline && !this.expanded
          ? html`<button class="btn" @click=${() => (this.expanded = true)}>Full screen</button>`
          : html`<button class="btn" @click=${() => this.close()}>
              ${this.inline ? 'Exit full screen' : 'Close'}
            </button>`}
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
              ${selected ? html`${this.renderMedia(claim)}${this.renderSteps(claim)}` : nothing}`;
          })}
        </nav>
        ${items.length
          ? html`<media-lightbox
              embedded
              open
              ?owns-keys=${!this.inline || this.expanded}
              hide-timeline
              .confine=${false}
              .items=${items}
              .selectedIndex=${0}
              expand-label="All files"
              @lightbox-expand=${() => this.showFiles()}
              @lightbox-close=${() => this.close()}
            ></media-lightbox>`
          : html`<div class="empty">No recording or screenshot for this criterion.</div>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'evidence-reviewer': EvidenceReviewer;
  }
}
