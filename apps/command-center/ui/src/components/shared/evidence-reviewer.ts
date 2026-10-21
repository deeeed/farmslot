import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';

import {
  type EvidenceReviewClaim,
  type EvidenceReviewModel,
  type EvidenceReviewOccurrence,
  formatEvidenceReviewVideoTime,
} from '@farmslot/adapter-sdk/evidence';
import { type AcceptanceClaimRow } from '@farmslot/review-dispatch';

import './media-lightbox.js';
import './proof-step-details.js';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';
import type { AcceptanceClaimListActions } from '../progress-tracker/acceptance-claim-list.js';
import { proofStepGroups } from '../progress-tracker/proof-step-groups.js';
import {
  renderVisualClaimJudgment,
  visualClaimJudgmentStyles,
} from '../workspace/visual-claim-judgment.js';
import { workspaceArtifactBasename } from '../workspace/workspace-artifacts.js';

import { isForeignRecording, modelRecording } from './evidence-reviewer-recording.js';
import type { EvidenceReviewerView } from './evidence-reviewer-url-state.js';
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
  /** Each criterion's state and, where a person must look, Looks right / Issue. */
  judgments?: EvidenceReviewerJudgments;
  /** Where a shared link left the recording. */
  atMs?: number;
  /** The step whose check a shared link left open, by trace index. */
  check?: number;
  /** Bumped each time the host applies a link: the review then shows that link's view. */
  link?: number;
}

/** The gate's verdicts on criteria, recorded from the review. */
export interface EvidenceReviewerJudgments extends Pick<
  AcceptanceClaimListActions,
  'busy' | 'feedback' | 'reviewReason' | 'changeReviewReason' | 'recordReview'
> {
  rows: readonly AcceptanceClaimRow[];
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
  const { model, resolveUrl } = input;
  // A video from another recipe run would carry that run's trace markers: open the
  // model's own recording. Hosts rebuild the selection as the model loads.
  const opened =
    input.opened &&
    isVideoLightboxItem(input.opened) &&
    isForeignRecording(model, input.opened.path)
      ? undefined
      : input.opened;
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

const NAV_WIDTH_KEY = 'farmslot:evidence-review-nav-width';
const DEFAULT_NAV_WIDTH = 340;

/** The criteria pane's width: 240-720px; CSS also keeps it under 60% of the review. */
export function clampReviewNavWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_NAV_WIDTH;
  return Math.max(240, Math.min(720, Math.round(width)));
}

/**
 * Full-screen review of a run's evidence against its acceptance criteria: the
 * criteria on the left, each with its proof steps and screenshots; the chosen
 * moment of the recording, or the chosen screenshot, in the main view.
 */
@customElement('evidence-reviewer')
export class EvidenceReviewer extends LitElement {
  @property({ attribute: false }) selection: EvidenceReviewerSelection | null = null;
  @state() private claimId = '';
  /** The step last chosen, highlighted in the list. */
  @state() private activeStep: number | null = null;
  /** The step whose check the dialog shows. */
  @state() private checkStep: number | null = null;
  @state() private navWidth = clampReviewNavWidth(Number(localStorage.getItem(NAV_WIDTH_KEY)));
  /** List criteria in the order the recording reaches them, or by id. */
  @state() private order: 'video' | 'criteria' = 'video';
  /** The screenshot in the main view instead of the recording. */
  @state() private still: LightboxItem | null = null;
  @query('media-lightbox') private player?: MediaLightbox;
  @query('nav') private nav?: HTMLElement;

  static styles = css`
    ${unsafeCSS(visualClaimJudgmentStyles())}
    .verdict {
      padding: 0 ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
    }
    .state {
      grid-column: 2 / -1;
      justify-self: start;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 1px 8px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 999px;
      background: color-mix(in srgb, currentColor 14%, transparent);
    }
    .state::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .state[data-tone='pending'] {
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .state[data-tone='proven'],
    .state[data-tone='verified'],
    .state[data-tone='checked'] {
      color: ${unsafeCSS(colors.statusOk)};
    }
    .state[data-tone='issue'] {
      color: ${unsafeCSS(colors.statusFail)};
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
      grid-template-columns: min(var(--nav-width), 60%) 6px minmax(0, 1fr);
    }
    .resize {
      cursor: col-resize;
      touch-action: none;
      background: ${unsafeCSS(colors.bgCardHover)};
      background-clip: content-box;
      padding: 0 2px;
    }
    .resize:hover,
    .resize:focus-visible {
      background: ${unsafeCSS(colors.accent)};
      padding: 0 1px;
      outline: none;
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
    .claim[aria-current='true'] .claim-text {
      max-height: none;
      display: block;
    }
    .muted {
      color: ${unsafeCSS(colors.textMuted)};
    }
    ol {
      list-style: none;
      margin: 0;
      padding: 0 0 ${unsafeCSS(spacing.sm)};
    }
    .step-row {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      padding-right: ${unsafeCSS(spacing.sm)};
    }
    .step {
      flex: 1;
      min-width: 0;
      display: grid;
      grid-template-columns: 4.5em 3em minmax(0, 1fr);
      gap: ${unsafeCSS(spacing.sm)};
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
    .step[aria-current='true'] {
      background: ${unsafeCSS(colors.bgCardHover)};
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
    .still img:not([src]) {
      color: transparent;
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
        border-top: 1px solid ${unsafeCSS(colors.bgCardHover)};
      }
      .resize {
        display: none;
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
    return (modelRecording(model, recording.path) ?? model.recordings[0])?.videoPath;
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
    // A link's moment and step check apply once, when the host applies that link.
    const newLink = changed.has('selection') && selection.link !== this.applied?.link;
    const reopened =
      newLink ||
      (changed.has('selection') &&
        (selection.claimId !== this.applied?.claimId ||
          selection.recording?.url !== this.applied?.recording?.url ||
          selection.opened?.path !== this.applied?.opened?.path));
    this.applied = selection;
    if (reopened) this.claimId = selection.claimId;
    const claimChanged = this.claimId !== this.appliedClaim;
    if (!claimChanged && !reopened && selection.model === this.appliedModel) return;
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
    this.activeStep = null;
    this.resumeMs = null;
    const start = claim ? this.startMs(claim) : null;
    const linkedAt = newLink ? selection.atMs : undefined;
    const linkedCheck =
      newLink && claim && this.steps(claim).some((step) => step.traceIndex === selection.check)
        ? selection.check
        : undefined;
    this.checkStep = linkedCheck ?? null;
    // Choosing a criterion shows its proof: the recording at its first step, or its
    // first screenshot when the recording does not cover it.
    if (opened || !this.recording || (start === null && claim && this.stills(claim).length)) {
      this.still = opened ?? (claim ? (this.stills(claim)[0] ?? null) : null);
      this.pendingSeekMs = null;
    } else {
      this.still = null;
      this.pendingSeekMs = linkedAt ?? this.openedMomentMs(reopened) ?? start;
    }
    this.announce({
      ...(this.still
        ? { path: this.still.path }
        : linkedAt !== undefined
          ? { atMs: linkedAt }
          : {}),
      ...(linkedCheck !== undefined ? { check: linkedCheck } : {}),
    });
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

  /** The view to report once this update lands, so the host can put it in the link. */
  private announced: EvidenceReviewerView | null = null;
  /** The view last reported, which opening or closing a step's check keeps. */
  private shown: Omit<EvidenceReviewerView, 'claimId'> = {};

  private announce(view: Omit<EvidenceReviewerView, 'claimId'> = {}) {
    if (!this.claimId) return;
    this.shown = view;
    this.announced = { claimId: this.claimId, ...view };
    this.requestUpdate();
  }

  protected updated(): void {
    if (this.announced) {
      const view = this.announced;
      this.announced = null;
      this.dispatchEvent(new CustomEvent('reviewer-view', { detail: view }));
    }
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
    this.activeStep = step.traceIndex;
    this.showVideo(ms);
    this.announce({ atMs: ms });
  }

  private showCheck(step: EvidenceReviewOccurrence) {
    this.checkStep = step.traceIndex;
    this.announce({ ...this.shown, check: step.traceIndex });
  }

  /** The step's check closed (Close, Escape): the link drops it. */
  private onCheckClosed() {
    if (this.checkStep === null) return;
    this.checkStep = null;
    const { check: _closed, ...view } = this.shown;
    this.announce(view);
  }

  /** Where a drag on the pane edge started, while it lasts. */
  private dragFrom: { x: number; width: number } | null = null;

  private startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.dragFrom = { x: event.clientX, width: this.nav?.offsetWidth ?? this.navWidth };
  }

  private moveResize(event: PointerEvent) {
    if (!this.dragFrom) return;
    this.navWidth = clampReviewNavWidth(this.dragFrom.width + event.clientX - this.dragFrom.x);
  }

  private endResize() {
    if (!this.dragFrom) return;
    this.dragFrom = null;
    localStorage.setItem(NAV_WIDTH_KEY, String(this.navWidth));
  }

  /** Arrow keys on the pane edge resize it; the player must not take them. */
  private keyResize(event: KeyboardEvent) {
    const delta = event.key === 'ArrowLeft' ? -24 : event.key === 'ArrowRight' ? 24 : 0;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    this.navWidth = clampReviewNavWidth((this.nav?.offsetWidth ?? this.navWidth) + delta);
    localStorage.setItem(NAV_WIDTH_KEY, String(this.navWidth));
  }

  private showStill(item: LightboxItem) {
    if (!this.still) this.resumeMs = this.player?.currentTimeMs() ?? null;
    this.still = item;
    this.announce({ path: item.path });
  }

  /** Back to the recording: at the given moment, where it was, or at the criterion's start. */
  private showVideo(ms: number | null = this.resumeMs ?? this.claimStartMs()) {
    if (this.still) this.still = null;
    if (ms === null) return;
    if (this.player?.currentTimeMs() != null) this.player.seekToMs(ms);
    else this.pendingSeekMs = ms;
  }

  /** The criterion's files in the host gallery. */
  private showFiles() {
    this.dispatchEvent(new CustomEvent('reviewer-files', { detail: { claimId: this.claimId } }));
  }

  /** Escape still leaves when no player is shown to take it (a criterion without media). */
  private onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || this.player) return;
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
    this.dispatchEvent(new CustomEvent('reviewer-close'));
  }

  private row(claim: EvidenceReviewClaim): AcceptanceClaimRow | undefined {
    return this.selection?.judgments?.rows.find((row) => row.id === claim.id);
  }

  /** Looks right / Issue for the criterion on screen, where a person must judge it. */
  private renderVerdict(claim: EvidenceReviewClaim) {
    const judgments = this.selection?.judgments;
    const judgment = this.row(claim)?.judgment;
    if (!judgments || !judgment || judgment.claim.status?.proofMode === 'state') return nothing;
    return html`<div class="verdict">
      ${renderVisualClaimJudgment({
        row: judgment,
        busy: judgments.busy || !judgments.recordReview,
        feedback: judgments.feedback,
        reason: judgments.reviewReason?.(claim.id) ?? '',
        changeReason: (reason) => judgments.changeReviewReason?.(claim.id, reason),
        record: (verdict) => judgments.recordReview?.(claim.id, verdict),
      })}
    </div>`;
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
        return html`<li class="step-row">
          <button
            class="step"
            aria-current=${this.activeStep === step.traceIndex}
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
          <proof-step-details
            .step=${step}
            heading=${`${claim.id} · step ${ms === null ? 'not in the recording' : formatEvidenceReviewVideoTime(ms / 1000, false)}`}
            .open=${this.checkStep === step.traceIndex}
            @proof-step-details-toggle=${(event: CustomEvent<{ open: boolean }>) =>
              event.detail.open ? this.showCheck(step) : this.onCheckClosed()}
          ></proof-step-details>
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
            @click=${() => {
              this.showVideo();
              this.announce();
            }}
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
        <button class="btn" @click=${() => this.close()}>Close</button>
      </header>
      <div class="body" style="--nav-width:${this.navWidth}px">
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
                ${this.row(claim)
                  ? html`<span class="state" data-tone=${this.row(claim)!.tone}
                      >${this.row(claim)!.state}</span
                    >`
                  : nothing}
                <span class="muted"
                  >${start === null
                    ? 'not recorded'
                    : formatEvidenceReviewVideoTime(start / 1000, false)}</span
                >
              </button>
              ${selected
                ? html`${this.renderVerdict(claim)}${this.renderMedia(claim)}${this.renderSteps(
                    claim,
                  )}`
                : nothing}`;
          })}
        </nav>
        <div
          class="resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize criteria list"
          aria-valuemin="240"
          aria-valuemax="720"
          aria-valuenow=${this.navWidth}
          tabindex="0"
          @pointerdown=${(event: PointerEvent) => this.startResize(event)}
          @pointermove=${(event: PointerEvent) => this.moveResize(event)}
          @pointerup=${() => this.endResize()}
          @pointercancel=${() => this.endResize()}
          @keydown=${(event: KeyboardEvent) => this.keyResize(event)}
        ></div>
        ${items.length
          ? html`<media-lightbox
              embedded
              open
              owns-keys
              hide-timeline
              .confine=${false}
              .items=${items}
              .selectedIndex=${0}
              .expandLabel=${current?.evidence.length ? 'All files' : ''}
              @lightbox-expand=${() => this.showFiles()}
              @lightbox-moment=${(event: CustomEvent<{ ms: number }>) =>
                this.announce({
                  atMs: event.detail.ms,
                  ...(this.checkStep !== null ? { check: this.checkStep } : {}),
                })}
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
