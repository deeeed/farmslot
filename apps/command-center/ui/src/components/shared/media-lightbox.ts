// <media-lightbox> — Shared fullscreen artifact viewer.
// Single mode: zoom, pan, keyboard nav, filmstrip.
// Compare mode: image slider overlay + synced two-pane video.
// Used by family-observability and review-workspace.

import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { RecipeRecordingMarker, RecipeRecordingTimelineDocument } from '@farmslot/protocol';

import '../diff-viewer/diff-review.js';

import { isolatedArtifactHtml } from '../../utils/artifact-html.js';
import { type ArtifactKind, artifactKind } from '../../utils/artifact-kind.js';
import {
  buildArtifactUrlResolver,
  rewriteMarkdownArtifactUrls,
} from '../../utils/artifact-markdown.js';
import { gatewayHttpFetch } from '../../utils/gateway-origin.js';
import { putCapped } from '../../utils/markdown.js';

import {
  isVideoLightboxItem,
  mediaLightboxFileType,
  mediaLightboxFileTypeBadge,
} from './media-lightbox-model.js';
import {
  formatLightboxTextPreview,
  type MediaLightboxTextPreviewKind,
} from './media-lightbox-preview-model.js';
import { MD_CACHE_LIMIT, MediaLightboxState } from './media-lightbox-state.js';
import { mediaLightboxStyles } from './media-lightbox-styles.js';
import type { LightboxItem, LightboxPair } from './media-lightbox-types.js';
import {
  adjacentVideoFrameMs,
  displayedVideoFrameRangeMs,
  loadVideoTimeline,
} from './media-lightbox-video-model.js';

@customElement('media-lightbox')
export class MediaLightbox extends MediaLightboxState {
  private _logTimer?: ReturnType<typeof setInterval>;
  private _logLoading = false;
  private _logText = '';
  private _logError = '';
  private _logUrl = '';
  private _logFollow = false;
  private _timelines = new Map<
    string,
    { data?: RecipeRecordingTimelineDocument; error?: string }
  >();
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKeyDown);
    if (this._logTimer) clearInterval(this._logTimer);
    this._mdCache.clear();
    this._timelines.clear();
  }

  updated(changed: Map<string, unknown>): void {
    const logItem =
      this.open && this.mode === 'single' ? this.items[this.selectedIndex] : undefined;
    const logUrl = logItem && mediaLightboxFileType(logItem) === 'log' ? logItem.url : '';
    if (logUrl !== this._logUrl) {
      if (this._logTimer) clearInterval(this._logTimer);
      this._logTimer = undefined;
      this._logUrl = logUrl;
      this._logText = '';
      this._logError = '';
      this._logFollow = false;
      if (logUrl) void this._refreshLog(logUrl);
    }

    if (changed.has('open') && this.open) this._timelines.clear();
    if (
      changed.has('selectedIndex') ||
      changed.has('open') ||
      changed.has('pairIndex') ||
      changed.has('mode')
    ) {
      this._resetView();
      this._divider = 50;
      this._appliedVideoMarker = '';
    }
    if (
      this.open &&
      ['open', 'items', 'pairs', 'selectedIndex', 'pairIndex', 'mode', '_kindFilter'].some((key) =>
        changed.has(key),
      )
    )
      void this._loadActiveVideoTimeline();
    if (changed.has('open') && this.open) {
      this.updateComplete.then(() => {
        this.renderRoot.querySelector<HTMLElement>('.ml-modal')?.focus();
      });
    }
    if (
      (changed.has('pairIndex') || changed.has('mode') || changed.has('open')) &&
      this.mode === 'compare'
    ) {
      this.updateComplete.then(() => this._wireVideoSync());
    }
  }

  private _resetView() {
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this._panning = false;
  }

  private _close() {
    this._maximized = false;
    this.dispatchEvent(new CustomEvent('lightbox-close'));
  }

  private _renderMaximizeControl() {
    return html`<button
      class="ml-btn"
      data-testid="artifact-maximize"
      aria-pressed=${this._maximized}
      title="Use the full application window"
      @click=${() => {
        this._maximized = !this._maximized;
      }}
    >
      ${this._maximized ? 'Restore' : 'Maximize'}
    </button>`;
  }

  private _visibleIndices(): number[] {
    if (this._kindFilter === 'all') return this.items.map((_, i) => i);
    const want = this._kindFilter;
    return this.items
      .map((item, i) => ({ i, kind: artifactKind(item.path, item.purpose) }))
      .filter(({ kind }) => kind === want)
      .map(({ i }) => i);
  }

  private _setKindFilter(next: ArtifactKind | 'all') {
    if (this._kindFilter === next) return;
    this._kindFilter = next;
    // Snap selection to first matching item; parent owns selectedIndex so dispatch.
    const visible = this._visibleIndices();
    if (visible.length === 0) return;
    if (!visible.includes(this.selectedIndex)) {
      this.dispatchEvent(new CustomEvent('lightbox-navigate', { detail: { index: visible[0] } }));
    }
  }

  private _navigate(dir: -1 | 1) {
    if (this.mode === 'compare') {
      if (this.pairs.length <= 1) return;
      const next = (this.pairIndex + dir + this.pairs.length) % this.pairs.length;
      this.dispatchEvent(new CustomEvent('lightbox-pair-navigate', { detail: { index: next } }));
      this.pairIndex = next;
      return;
    }
    const visible = this._visibleIndices();
    if (visible.length <= 1) return;
    const here = Math.max(0, visible.indexOf(this.selectedIndex));
    const nextPos = (here + dir + visible.length) % visible.length;
    const next = visible[nextPos];
    this.dispatchEvent(new CustomEvent('lightbox-navigate', { detail: { index: next } }));
  }

  private _toggleMode() {
    if (this.pairs.length === 0) return;
    this.mode = this.mode === 'single' ? 'compare' : 'single';
    this.dispatchEvent(new CustomEvent('lightbox-mode-change', { detail: { mode: this.mode } }));
  }

  private _clearScope(currentPath?: string) {
    this.dispatchEvent(
      new CustomEvent('lightbox-clear-scope', {
        detail: { path: currentPath ?? null },
      }),
    );
  }

  private _onKeyDown = (e: KeyboardEvent) => {
    if (!this.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this._close();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this._navigate(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this._navigate(-1);
    } else if (e.key.toLowerCase() === 'c' && this.pairs.length > 0) {
      e.preventDefault();
      this._toggleMode();
    } else if (e.key === ' ' || e.code === 'Space') {
      if (this.mode === 'compare') {
        const pair = this.pairs[this.pairIndex];
        if (!pair || pair.kind !== 'video') return;
      } else {
        const item = this.items[this.selectedIndex];
        if (!item || !isVideoLightboxItem(item)) return;
      }
      e.preventDefault();
      this._toggleVideoPlayback();
    }
  };

  private _zoomBy(delta: number) {
    this._zoom = Math.max(1, Math.min(4, Number((this._zoom + delta).toFixed(2))));
    if (this._zoom === 1) {
      this._panX = 0;
      this._panY = 0;
    }
  }

  private _onPointerDown(e: PointerEvent) {
    if (this._zoom <= 1) return;
    this._panning = true;
    this._panStartX = e.clientX - this._panX;
    this._panStartY = e.clientY - this._panY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._panning || this._zoom <= 1) return;
    this._panX = e.clientX - this._panStartX;
    this._panY = e.clientY - this._panStartY;
  }

  private _onPointerUp(e: PointerEvent) {
    this._panning = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  private _onDividerDown(e: PointerEvent) {
    this._draggingDivider = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    this._moveDivider(e);
  }

  private _onDividerMove(e: PointerEvent) {
    if (!this._draggingDivider) return;
    this._moveDivider(e);
  }

  private _onDividerUp(e: PointerEvent) {
    this._draggingDivider = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  private _moveDivider(e: PointerEvent) {
    const stage = this.renderRoot.querySelector<HTMLElement>('.ml-cmp-stage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    this._divider = Math.max(0, Math.min(100, pct));
  }

  private _markBroken(idx: number) {
    const next = new Set(this._broken);
    next.add(idx);
    this._broken = next;
  }

  private _wireVideoSync() {
    const a = this.renderRoot.querySelector<HTMLVideoElement>('.ml-cmp-video.a');
    const b = this.renderRoot.querySelector<HTMLVideoElement>('.ml-cmp-video.b');
    if (!a || !b) return;

    // Idempotent: overwrite handlers each time
    const run = (fn: () => void) => {
      if (this._videoSyncing) return;
      this._videoSyncing = true;
      try {
        fn();
      } finally {
        this._videoSyncing = false;
      }
    };

    a.onplay = () =>
      run(() => {
        if (b.paused) void b.play();
      });
    a.onpause = () =>
      run(() => {
        if (!b.paused) b.pause();
      });
    a.onseeked = () =>
      run(() => {
        if (Math.abs(b.currentTime - a.currentTime) > 0.1) b.currentTime = a.currentTime;
      });
    a.ontimeupdate = () =>
      run(() => {
        if (Math.abs(b.currentTime - a.currentTime) > 0.25) b.currentTime = a.currentTime;
      });

    b.onplay = () =>
      run(() => {
        if (a.paused) void a.play();
      });
    b.onpause = () =>
      run(() => {
        if (!a.paused) a.pause();
      });
    b.onseeked = () =>
      run(() => {
        if (Math.abs(a.currentTime - b.currentTime) > 0.1) a.currentTime = b.currentTime;
      });
    b.ontimeupdate = () =>
      run(() => {
        if (Math.abs(a.currentTime - b.currentTime) > 0.25) a.currentTime = b.currentTime;
      });
  }

  private _primaryVideo(): HTMLVideoElement | null {
    return this.renderRoot.querySelector<HTMLVideoElement>(
      this.mode === 'compare' ? '.ml-cmp-video.a' : '.ml-video',
    );
  }

  private _secondaryVideo(): HTMLVideoElement | null {
    return this.mode === 'compare'
      ? this.renderRoot.querySelector<HTMLVideoElement>('.ml-cmp-video.b')
      : null;
  }

  private _videoSet(): HTMLVideoElement[] {
    return [this._primaryVideo(), this._secondaryVideo()].filter(
      (video): video is HTMLVideoElement => Boolean(video),
    );
  }

  private _syncVideoState(video: HTMLVideoElement | null = this._primaryVideo()): void {
    if (!video) return;
    this._videoTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    this._videoDuration = Number.isFinite(video.duration) ? video.duration : 0;
    this._videoPaused = video.paused;
    this._videoRate = video.playbackRate || 1;
    this._applyInitialVideoMarker();
  }

  private _syncPrimaryVideoState(): void {
    this._syncVideoState(this._primaryVideo());
  }

  private _toggleVideoPlayback(): void {
    const video = this._primaryVideo();
    if (!video) return;
    const videos = this._videoSet();
    if (video.paused) {
      for (const candidate of videos) {
        candidate.playbackRate = this._videoRate;
        if (candidate !== video && Math.abs(candidate.currentTime - video.currentTime) > 0.1) {
          candidate.currentTime = video.currentTime;
        }
      }
      for (const candidate of videos) {
        void candidate.play();
      }
    } else {
      for (const candidate of videos) candidate.pause();
    }
    this._syncVideoState(video);
  }

  private _pauseVideoPlayback(): void {
    const video = this._primaryVideo();
    for (const candidate of this._videoSet()) candidate.pause();
    this._syncVideoState(video);
  }

  private _seekVideo(deltaSeconds: number): void {
    const video = this._primaryVideo();
    if (!video) return;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const next = Math.max(0, duration ? Math.min(duration, video.currentTime + deltaSeconds) : 0);
    for (const candidate of this._videoSet()) {
      candidate.currentTime = next;
    }
    this._syncVideoState(video);
  }

  private _activeVideoItem(): LightboxItem | undefined {
    return this.mode === 'compare'
      ? this.pairs[this.pairIndex]?.before
      : (this.items.find((item) => item.url === this._primaryVideo()?.getAttribute('src')) ??
          this.items[this.selectedIndex]);
  }

  private _timelineState() {
    const item = this._activeVideoItem();
    return item
      ? this._timelines.get(`${item.url}:${item.sha256 ?? ''}:${item.timelinePath ?? ''}`)
      : undefined;
  }

  private async _loadActiveVideoTimeline(): Promise<void> {
    const item = this._activeVideoItem();
    if (!item || !isVideoLightboxItem(item)) return;
    const key = `${item.url}:${item.sha256 ?? ''}:${item.timelinePath ?? ''}`;
    if (this._timelines.has(key)) return;
    putCapped(this._timelines, key, {}, MD_CACHE_LIMIT);
    try {
      const data = await loadVideoTimeline(item, async (url) => {
        const response = await gatewayHttpFetch(url);
        if (!response.ok)
          throw new Error(`Recording evidence could not be read (${response.status}).`);
        return response.json();
      });
      putCapped(this._timelines, key, { data }, MD_CACHE_LIMIT);
      this._applyInitialVideoMarker();
    } catch (error) {
      putCapped(
        this._timelines,
        key,
        { error: error instanceof Error ? error.message : String(error) },
        MD_CACHE_LIMIT,
      );
    }
    this.requestUpdate();
  }

  private _stepVideo(direction: -1 | 1): void {
    const video = this._primaryVideo();
    const timing = this._timelineState()?.data;
    if (!video || !timing) return;
    const next = adjacentVideoFrameMs(timing.framesMs, video.currentTime * 1000, direction);
    if (next === null) return;
    this._pauseVideoPlayback();
    this._scrubVideo(String(next / 1000));
  }

  private _seekMarker(marker: RecipeRecordingMarker, phase: 'start' | 'end'): void {
    const range = phase === 'start' ? marker.startRangeMs : marker.endRangeMs;
    const duration = this._primaryVideo()?.duration;
    if (!Number.isFinite(duration) || !duration || range[1] < 0 || range[0] >= duration * 1000)
      return;
    this._pauseVideoPlayback();
    this._scrubVideo(String(Math.max(0, Math.min(duration, (range[0] + range[1]) / 2000))));
  }

  private _appliedVideoMarker = '';
  private _applyInitialVideoMarker(): void {
    const item = this._activeVideoItem();
    const data = this._timelineState()?.data;
    const video = this._primaryVideo();
    if (item?.initialTraceIndex === undefined || !data || !video || video.readyState < 1) return;
    const key = `${item.url}:${item.initialTraceIndex}:${item.initialTracePhase}`;
    if (key === this._appliedVideoMarker) return;
    const marker = data.markers.find((marker) => marker.traceIndex === item.initialTraceIndex);
    if (!marker) return;
    this._appliedVideoMarker = key;
    this._seekMarker(marker, item.initialTracePhase ?? 'end');
  }

  private _renderVideoMarkers() {
    const state = this._timelineState();
    if (!state?.data)
      return html`<p class="ml-count">${state?.error ?? 'Loading recording frame index…'}</p>`;
    const timing = state.data;
    const uncertainty = timing.clock.latestZeroUnixMs - timing.clock.earliestZeroUnixMs;
    return html`<details class="ml-video-markers" data-testid="video-markers">
      <summary>Actions and proof markers (${timing.markers.length})</summary>
      <p class="ml-count">
        ${timing.framesMs.length} decoded frames · clock calibration window
        ${Math.ceil(uncertainty)} ms. Frame hold intervals below describe visual sampling,
        separately from clock precision.
      </p>
      <div class="ml-marker-list">
        ${timing.markers.map(
          (marker) =>
            html`<div class="ml-marker">
              <span
                >${marker.intent ?? marker.nodeId}<small
                  >${marker.nodeId} ·
                  ${marker.action}${marker.proves?.length
                    ? ` · ${marker.proves.join(', ')}`
                    : ''}</small
                ></span
              >
              ${(['start', 'end'] as const).map((phase) => {
                const bounds = phase === 'start' ? marker.startRangeMs : marker.endRangeMs;
                const outside = bounds[1] < 0 || bounds[0] >= timing.durationMs;
                const frame = displayedVideoFrameRangeMs(
                  timing.framesMs,
                  timing.durationMs,
                  Math.max(0, (bounds[0] + bounds[1]) / 2),
                );
                return html`<button
                  class="ml-btn"
                  data-testid="video-marker"
                  data-trace-index=${marker.traceIndex}
                  data-phase=${phase}
                  ?disabled=${outside}
                  title=${outside
                    ? 'Outside recorded footage'
                    : `Action clock window ${bounds[0].toFixed(1)}–${bounds[1].toFixed(1)} ms. The displayed frame may precede the action result.`}
                  @click=${() => this._seekMarker(marker, phase)}
                >
                  ${phase}
                  ${outside
                    ? 'unrecorded'
                    : this._formatVideoTime(Math.max(0, (bounds[0] + bounds[1]) / 2000))}
                  ${frame
                    ? html`<small
                        >frame held
                        ${this._formatVideoTime(frame[0] / 1000)}–${this._formatVideoTime(
                          frame[1] / 1000,
                        )}</small
                      >`
                    : nothing}
                </button>`;
              })}
            </div>`,
        )}
      </div>
    </details>`;
  }

  private _scrubVideo(value: string): void {
    const video = this._primaryVideo();
    if (!video) return;
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    for (const candidate of this._videoSet()) {
      candidate.currentTime = next;
    }
    this._syncVideoState(video);
  }

  private _setVideoRate(rate: number): void {
    this._videoRate = rate;
    for (const candidate of this._videoSet()) {
      candidate.playbackRate = rate;
    }
  }

  private _formatVideoTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00.00';
    const minutes = Math.floor(seconds / 60);
    const wholeSeconds = Math.floor(seconds % 60);
    const hundredths = Math.floor((seconds % 1) * 100);
    return `${minutes}:${String(wholeSeconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  private _renderVideoControls(compare = false) {
    const duration = this._videoDuration || 0;
    const time = duration ? Math.min(this._videoTime, duration) : this._videoTime;
    const RATES = [0.25, 0.5, 1, 2];
    const hasFrameIndex = Boolean(this._timelineState()?.data);
    return html`
      <div class="ml-video-controls" data-testid="media-lightbox-video-controls">
        <div class="ml-video-control-row">
          <button class="ml-btn" @click=${() => this._toggleVideoPlayback()}>
            ${this._videoPaused ? 'Play' : 'Pause'}
          </button>
          <button class="ml-btn" @click=${() => this._seekVideo(-1)}>−1s</button>
          <button class="ml-btn" @click=${() => this._seekVideo(-0.1)}>−0.1s</button>
          <button
            class="ml-btn"
            title="Step to the adjacent measured frame"
            ?disabled=${!hasFrameIndex}
            data-testid="video-previous-frame"
            @click=${() => this._stepVideo(-1)}
          >
            Previous frame
          </button>
          <button
            class="ml-btn"
            title="Step to the adjacent measured frame"
            ?disabled=${!hasFrameIndex}
            data-testid="video-next-frame"
            @click=${() => this._stepVideo(1)}
          >
            Next frame
          </button>
          <button class="ml-btn" @click=${() => this._seekVideo(0.1)}>+0.1s</button>
          <button class="ml-btn" @click=${() => this._seekVideo(1)}>+1s</button>
          ${RATES.map(
            (rate) => html`
              <button
                class="ml-btn ${this._videoRate === rate ? 'active' : ''}"
                data-testid=${`video-rate-${rate}`}
                @click=${() => this._setVideoRate(rate)}
              >
                ${rate}×
              </button>
            `,
          )}
        </div>
        <div class="ml-video-scrub-row">
          <span class="ml-count">${compare ? 'Synced' : 'Video'} · Space play/pause</span>
          <input
            class="ml-video-scrub"
            type="range"
            min="0"
            max=${duration || 0}
            step="0.01"
            .value=${String(time)}
            ?disabled=${duration <= 0}
            @input=${(event: Event) => this._scrubVideo((event.target as HTMLInputElement).value)}
            aria-label="Video timeline"
          />
          <span class="ml-count">
            ${this._formatVideoTime(time)} / ${this._formatVideoTime(duration)}
          </span>
        </div>
        ${this._renderVideoMarkers()}
      </div>
    `;
  }

  override render() {
    if (!this.open) return nothing;
    const hasPairs = this.pairs.length > 0;
    const compare = this.mode === 'compare' && hasPairs;

    if (compare) return this._renderCompare();

    if (this.items.length === 0) return nothing;
    const visible = this._visibleIndices();
    // Snap to a visible item if current selection is filtered out and at least one match exists.
    const selectedIdx =
      visible.includes(this.selectedIndex) || visible.length === 0
        ? this.selectedIndex
        : visible[0];
    const item = this.items[selectedIdx];
    if (!item) return nothing;
    const hasMultiple = this.items.length > 1;
    const broken = this._broken.has(selectedIdx);
    const FILTER_CHIPS: { label: string; value: ArtifactKind | 'all' }[] = [
      { label: 'All', value: 'all' },
      { label: 'Before', value: 'before' },
      { label: 'After', value: 'after' },
      { label: 'Setup', value: 'setup' },
    ];
    const showFilter = this.items.length > 4;
    const scoped = Boolean(this.scopeLabel);
    const totalItems = this.totalItems || this.items.length;
    const fileType = mediaLightboxFileType(item);

    return html`
      <div
        class=${`ml-backdrop ${this._maximized ? 'maximized' : ''}`}
        @click=${() => this._close()}
      >
        <div class="ml-modal" tabindex="0" @click=${(e: Event) => e.stopPropagation()}>
          <div class="ml-header">
            <div>
              <div class="ml-purpose-row">
                <span class=${`ml-file-type ${fileType}`}
                  >${mediaLightboxFileTypeBadge(fileType)}</span
                >
                <span class="ml-purpose">${item.purpose}</span>
              </div>
              <div class="ml-path">${item.path}</div>
              ${item.provenance
                ? html`<div class="ml-provenance">${item.provenance}</div>`
                : nothing}
              ${item.caption ? html`<div class="ml-caption">${item.caption}</div>` : nothing}
              ${scoped
                ? html`
                    <div class="ml-scope">
                      <span
                        >${this.scopeLabel}:
                        ${this.items.length}${totalItems > this.items.length
                          ? ` of ${totalItems}`
                          : ''}
                        artifact${this.items.length === 1 ? '' : 's'}</span
                      >
                      ${totalItems > this.items.length
                        ? html`<button
                            class="ml-scope-clear"
                            @click=${() => this._clearScope(item.path)}
                          >
                            Show all
                          </button>`
                        : nothing}
                    </div>
                  `
                : nothing}
              ${hasMultiple
                ? html`<div class="ml-count">
                    ${this._kindFilter === 'all'
                      ? `${selectedIdx + 1} / ${this.items.length}`
                      : `${visible.indexOf(selectedIdx) + 1} / ${visible.length} (${this._kindFilter}) · ${this.items.length} total`}
                    · ← → to navigate
                  </div>`
                : nothing}
              ${showFilter
                ? html`
                    <div class="ml-kind-filter">
                      ${FILTER_CHIPS.map(
                        (c) => html`
                          <button
                            class="ml-kind-chip ${this._kindFilter === c.value ? 'active' : ''}"
                            title=${c.value === 'before'
                              ? 'Baseline captures from main'
                              : c.value === 'after'
                                ? 'Captures from the fix branch'
                                : c.value === 'setup'
                                  ? 'Orientation/setup shots'
                                  : 'Show all evidence'}
                            @click=${() => this._setKindFilter(c.value)}
                          >
                            ${c.label}
                          </button>
                        `,
                      )}
                    </div>
                  `
                : nothing}
            </div>
            <div class="ml-actions">
              ${hasPairs
                ? html`<button
                    class="ml-btn"
                    @click=${() => this._toggleMode()}
                    title="Toggle compare mode (c)"
                  >
                    Compare (${this.pairs.length})
                  </button>`
                : nothing}
              ${hasMultiple
                ? html`
                    <button class="ml-btn" @click=${() => this._navigate(-1)}>Prev</button>
                    <button class="ml-btn" @click=${() => this._navigate(1)}>Next</button>
                  `
                : nothing}
              ${this._renderMaximizeControl()}
              <button class="ml-btn" @click=${() => this._close()}>Close</button>
            </div>
          </div>
          <div class="ml-body ${fileType === 'log' ? 'ml-log-body' : ''}">
            ${broken
              ? html`<div class="ml-fallback ml-broken">This media could not be loaded.</div>`
              : fileType === 'image'
                ? html` <div class="ml-image-shell">
                    <div class="ml-toolbar">
                      <button
                        class="ml-btn"
                        @click=${() => this._zoomBy(-0.25)}
                        ?disabled=${this._zoom <= 1}
                      >
                        −
                      </button>
                      <span class="ml-count">${Math.round(this._zoom * 100)}%</span>
                      <button
                        class="ml-btn"
                        @click=${() => this._zoomBy(0.25)}
                        ?disabled=${this._zoom >= 4}
                      >
                        +
                      </button>
                      <button
                        class="ml-btn"
                        @click=${() => this._resetView()}
                        ?disabled=${this._zoom === 1 && this._panX === 0 && this._panY === 0}
                      >
                        Reset
                      </button>
                    </div>
                    <div class="ml-stage">
                      <img
                        class="ml-expanded"
                        src=${item.url}
                        alt=${item.path}
                        @error=${() => this._markBroken(selectedIdx)}
                        style=${`transform: translate(${this._panX}px, ${this._panY}px) scale(${this._zoom}); cursor: ${this._zoom > 1 ? 'grab' : 'zoom-in'};`}
                        @pointerdown=${(e: PointerEvent) => this._onPointerDown(e)}
                        @pointermove=${(e: PointerEvent) => this._onPointerMove(e)}
                        @pointerup=${(e: PointerEvent) => this._onPointerUp(e)}
                        @pointercancel=${(e: PointerEvent) => this._onPointerUp(e)}
                      />
                    </div>
                  </div>`
                : fileType === 'video'
                  ? html`
                      <div class="ml-video-shell">
                        <video
                          class="ml-expanded ml-video"
                          src=${item.url}
                          autoplay
                          preload="metadata"
                          @click=${() => this._toggleVideoPlayback()}
                          @loadedmetadata=${(event: Event) =>
                            this._syncVideoState(event.currentTarget as HTMLVideoElement)}
                          @timeupdate=${(event: Event) =>
                            this._syncVideoState(event.currentTarget as HTMLVideoElement)}
                          @play=${(event: Event) =>
                            this._syncVideoState(event.currentTarget as HTMLVideoElement)}
                          @pause=${(event: Event) =>
                            this._syncVideoState(event.currentTarget as HTMLVideoElement)}
                          @ratechange=${(event: Event) =>
                            this._syncVideoState(event.currentTarget as HTMLVideoElement)}
                          @seeked=${(event: Event) =>
                            this._syncVideoState(event.currentTarget as HTMLVideoElement)}
                          @ended=${() => this._pauseVideoPlayback()}
                          @error=${() => this._markBroken(selectedIdx)}
                        ></video>
                        ${this._renderVideoControls(false)}
                      </div>
                    `
                  : fileType === 'log'
                    ? this._renderLogItem(item)
                    : fileType === 'html'
                      ? this._renderHtmlItem(item)
                      : fileType === 'markdown'
                        ? this._renderMarkdownItem(item)
                        : fileType === 'json'
                          ? this._renderJsonItem(item)
                          : fileType === 'diff'
                            ? this._renderDiffItem(item)
                            : html` <div class="ml-fallback">
                                <div>No inline preview for this artifact type.</div>
                                <div class="ml-fallback-meta">${item.path} · ${item.purpose}</div>
                                <a class="ml-btn" href=${item.url} target="_blank" rel="noopener"
                                  >Open raw</a
                                >
                              </div>`}
          </div>
          ${hasMultiple
            ? html`
                <div class="ml-filmstrip">
                  ${visible.map((i) => {
                    const candidate = this.items[i];
                    return html`
                      <button
                        class="ml-film-item ${i === selectedIdx ? 'selected' : ''}"
                        @click=${() =>
                          this.dispatchEvent(
                            new CustomEvent('lightbox-navigate', { detail: { index: i } }),
                          )}
                        title=${candidate.path}
                      >
                        ${mediaLightboxFileType(candidate) === 'image'
                          ? html`<div class="ml-film-thumb-wrap">
                              <img
                                class="ml-film-thumb"
                                src=${candidate.url}
                                alt=${candidate.path}
                                loading="lazy"
                              /><span class="ml-film-type">IMAGE</span>
                            </div>`
                          : mediaLightboxFileType(candidate) === 'video'
                            ? html`<div class="ml-film-thumb-wrap">
                                <video
                                  class="ml-film-thumb"
                                  src=${candidate.url}
                                  muted
                                  preload="metadata"
                                ></video
                                ><span class="ml-film-type">VIDEO</span>
                              </div>`
                            : mediaLightboxFileType(candidate) === 'markdown'
                              ? html`<div class="ml-film-thumb-wrap">
                                  <div class="ml-film-thumb ml-film-md">
                                    MD<br /><span
                                      >${(candidate.path.split('/').pop() ?? '').replace(
                                        /\.[^.]+$/,
                                        '',
                                      )}</span
                                    >
                                  </div>
                                  <span class="ml-film-type">MD</span>
                                </div>`
                              : mediaLightboxFileType(candidate) === 'json'
                                ? html`<div class="ml-film-thumb-wrap">
                                    <div class="ml-film-thumb ml-film-md">
                                      JSON<br /><span
                                        >${(candidate.path.split('/').pop() ?? '').replace(
                                          /\.[^.]+$/,
                                          '',
                                        )}</span
                                      >
                                    </div>
                                    <span class="ml-film-type">JSON</span>
                                  </div>`
                                : html`<div class="ml-film-thumb-wrap">
                                    <div class="ml-film-thumb ml-film-fallback">
                                      ${candidate.purpose}
                                    </div>
                                    <span class="ml-film-type"
                                      >${mediaLightboxFileTypeBadge(
                                        mediaLightboxFileType(candidate),
                                      )}</span
                                    >
                                  </div>`}
                        <span class="ml-film-idx">${i + 1}</span>
                      </button>
                    `;
                  })}
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderCompare() {
    const pair = this.pairs[this.pairIndex];
    if (!pair) return nothing;
    const hasMultiple = this.pairs.length > 1;
    const scoped = Boolean(this.scopeLabel);
    const totalItems = this.totalItems || this.items.length;
    return html`
      <div
        class=${`ml-backdrop ${this._maximized ? 'maximized' : ''}`}
        @click=${() => this._close()}
      >
        <div class="ml-modal" tabindex="0" @click=${(e: Event) => e.stopPropagation()}>
          <div class="ml-header">
            <div>
              <div class="ml-purpose">COMPARE · ${pair.kind.toUpperCase()}</div>
              <div class="ml-path">${pair.stem}</div>
              <div class="ml-caption">before: ${pair.before.path} · after: ${pair.after.path}</div>
              ${scoped
                ? html`
                    <div class="ml-scope">
                      <span
                        >${this.scopeLabel}:
                        ${this.items.length}${totalItems > this.items.length
                          ? ` of ${totalItems}`
                          : ''}
                        artifact${this.items.length === 1 ? '' : 's'}</span
                      >
                      ${totalItems > this.items.length
                        ? html`<button
                            class="ml-scope-clear"
                            @click=${() => this._clearScope(pair.before.path)}
                          >
                            Show all
                          </button>`
                        : nothing}
                    </div>
                  `
                : nothing}
              ${pair.before.provenance || pair.after.provenance
                ? html`
                    <div class="ml-provenance">
                      ${pair.before.provenance
                        ? html`<span>before · ${pair.before.provenance}</span>`
                        : nothing}
                      ${pair.before.provenance && pair.after.provenance
                        ? html`<span class="ml-provenance-sep"> | </span>`
                        : nothing}
                      ${pair.after.provenance
                        ? html`<span>after · ${pair.after.provenance}</span>`
                        : nothing}
                    </div>
                  `
                : nothing}
              ${hasMultiple
                ? html`<div class="ml-count">
                    ${this.pairIndex + 1} / ${this.pairs.length} pairs · ← → navigate · c to exit
                  </div>`
                : html`<div class="ml-count">c to exit compare</div>`}
            </div>
            <div class="ml-actions">
              <button
                class="ml-btn"
                @click=${() => this._toggleMode()}
                title="Back to single view (c)"
              >
                Single
              </button>
              ${hasMultiple
                ? html`
                    <button class="ml-btn" @click=${() => this._navigate(-1)}>Prev</button>
                    <button class="ml-btn" @click=${() => this._navigate(1)}>Next</button>
                  `
                : nothing}
              ${this._renderMaximizeControl()}
              <button class="ml-btn" @click=${() => this._close()}>Close</button>
            </div>
          </div>
          <div class="ml-body ml-cmp-body">
            ${pair.kind === 'image' ? this._renderImagePair(pair) : this._renderVideoPair(pair)}
          </div>
          ${hasMultiple
            ? html`
                <div class="ml-filmstrip">
                  ${this.pairs.map(
                    (p, i) => html`
                      <button
                        class="ml-film-item ml-film-pair ${i === this.pairIndex ? 'selected' : ''}"
                        @click=${() => {
                          this.pairIndex = i;
                          this.dispatchEvent(
                            new CustomEvent('lightbox-pair-navigate', { detail: { index: i } }),
                          );
                        }}
                        title=${p.stem}
                      >
                        <div class="ml-film-pair-row">
                          ${p.kind === 'image'
                            ? html`<img
                                  class="ml-film-thumb ml-film-half"
                                  src=${p.before.url}
                                  alt=${p.before.path}
                                  loading="lazy"
                                />
                                <img
                                  class="ml-film-thumb ml-film-half"
                                  src=${p.after.url}
                                  alt=${p.after.path}
                                  loading="lazy"
                                />`
                            : html`<video
                                  class="ml-film-thumb ml-film-half"
                                  src=${p.before.url}
                                  muted
                                  preload="metadata"
                                ></video>
                                <video
                                  class="ml-film-thumb ml-film-half"
                                  src=${p.after.url}
                                  muted
                                  preload="metadata"
                                ></video>`}
                        </div>
                        <span class="ml-film-idx">${p.stem.slice(0, 18)}</span>
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private _ensureTextPreview(url: string, kind: MediaLightboxTextPreviewKind): void {
    if (this._mdCache.has(url)) return;
    putCapped(this._mdCache, url, { status: 'loading' }, MD_CACHE_LIMIT);
    gatewayHttpFetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        const document = this.items.find((item) => item.url === url);
        const byPath = new Map(this.items.map((item) => [item.path, item.url]));
        const content =
          kind === 'markdown'
            ? rewriteMarkdownArtifactUrls(
                text,
                buildArtifactUrlResolver(
                  byPath.keys(),
                  (file) => byPath.get(file)!,
                  document?.path,
                ),
              )
            : text;
        putCapped(
          this._mdCache,
          url,
          {
            status: 'ok',
            data:
              kind === 'html'
                ? isolatedArtifactHtml(content, (rawPath) => {
                    const resolve = buildArtifactUrlResolver(
                      byPath.keys(),
                      (file) => file,
                      document?.path,
                    );
                    const file = resolve(rawPath);
                    const item = this.items.find((item) => item.path === file);
                    return item ? { mediaUrl: item.url, viewUrl: item.viewUrl } : null;
                  })
                : formatLightboxTextPreview(kind, content),
          },
          MD_CACHE_LIMIT,
        );
        this._mdCacheVersion += 1;
      })
      .catch((err: Error) => {
        putCapped(this._mdCache, url, { status: 'err', error: err.message }, MD_CACHE_LIMIT);
        this._mdCacheVersion += 1;
      });
  }

  private _renderHtmlItem(item: LightboxItem) {
    void this._mdCacheVersion;
    this._ensureTextPreview(item.url, 'html');
    const entry = this._mdCache.get(item.url);
    return html`<div class="ml-html-shell">
      <div class="ml-toolbar">
        <span class="ml-count">${item.path}</span>
        <a class="ml-btn" href=${item.url} download=${item.path.split('/').pop()}>Download HTML</a>
      </div>
      ${entry?.status === 'ok'
        ? html`<iframe
            class="ml-html-frame"
            title=${item.path}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerpolicy="no-referrer"
            .srcdoc=${entry.data}
          ></iframe>`
        : entry?.status === 'err'
          ? html`<div class="ml-fallback ml-broken">Failed to load: ${entry.error}</div>`
          : html`<div class="ml-fallback">Loading report…</div>`}
    </div>`;
  }

  private _renderMarkdownItem(item: LightboxItem) {
    void this._mdCacheVersion; // touch to keep render reactive to cache updates
    this._ensureTextPreview(item.url, 'markdown');
    const entry = this._mdCache.get(item.url);
    return html`
      <div class="ml-md-shell">
        <div class="ml-toolbar ml-md-toolbar">
          <span class="ml-count">${item.path}</span>
          <a class="ml-btn" href=${item.url} target="_blank" rel="noopener">Open raw</a>
        </div>
        <div class="ml-md-body">
          ${entry?.status === 'loading' || !entry
            ? html`<div class="ml-fallback">Loading…</div>`
            : entry.status === 'err'
              ? html`<div class="ml-fallback ml-broken">Failed to load: ${entry.error}</div>`
              : html`<div
                  class="ml-md-content"
                  @click=${(event: MouseEvent) => {
                    const anchor = (event.target as Element).closest('a');
                    if (!anchor) return;
                    const index = this.items.findIndex(
                      (candidate) => new URL(candidate.url, location.href).href === anchor.href,
                    );
                    if (index < 0) return;
                    event.preventDefault();
                    this.dispatchEvent(
                      new CustomEvent('lightbox-navigate', {
                        detail: { index },
                        bubbles: true,
                        composed: true,
                      }),
                    );
                  }}
                >
                  ${unsafeHTML(entry.data)}
                </div>`}
        </div>
      </div>
    `;
  }

  private async _refreshLog(url: string): Promise<void> {
    if (this._logLoading) return;
    this._logLoading = true;
    this.requestUpdate();
    try {
      const response = await gatewayHttpFetch(url, {
        cache: 'no-store',
        headers: { Range: 'bytes=-65536' },
      });
      // A zero-byte log has no satisfiable suffix range yet.
      if (response.status === 416 && response.headers.get('Content-Range') === 'bytes */0') {
        if (this._logUrl === url) {
          this._logText = '';
          this._logError = '';
        }
      } else {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (this._logUrl === url) {
          this._logText = text;
          this._logError = '';
        }
      }
    } catch (error) {
      if (this._logUrl === url) this._logError = (error as Error).message;
    } finally {
      this._logLoading = false;
      this.requestUpdate();
      if (this._logUrl && this._logUrl !== url) void this._refreshLog(this._logUrl);
      if (this._logFollow && this._logUrl === url) {
        await this.updateComplete;
        const body = this.renderRoot.querySelector('.ml-log-body .ml-md-body');
        if (body) body.scrollTop = body.scrollHeight;
      }
    }
  }

  private _renderLogItem(item: LightboxItem) {
    return html`<div class="ml-md-shell">
      <div class="ml-toolbar ml-md-toolbar">
        <span class="ml-count">${item.path} · latest 64 KiB</span>
        <button
          class="ml-btn"
          ?disabled=${this._logLoading}
          @click=${() => this._refreshLog(item.url)}
        >
          Refresh
        </button>
        <button
          class="ml-btn"
          data-testid="operation-log-follow"
          aria-pressed=${this._logFollow}
          @click=${() => {
            this._logFollow = !this._logFollow;
            if (this._logTimer) clearInterval(this._logTimer);
            this._logTimer = this._logFollow
              ? setInterval(() => {
                  if (this.open && this._logUrl) void this._refreshLog(this._logUrl);
                }, 2000)
              : undefined;
            this.requestUpdate();
          }}
        >
          ${this._logFollow ? 'Stop following' : 'Follow log'}
        </button>
        <a class="ml-btn" href=${item.url} target="_blank" rel="noopener">Open full log</a>
      </div>
      <div class="ml-md-body">
        ${this._logError ? html`<p role="status">Log unavailable: ${this._logError}</p>` : nothing}
        <pre class="ml-json-content">
${this._logText || (this._logLoading ? 'Loading…' : 'No output recorded yet.')}</pre
        >
      </div>
    </div>`;
  }

  private _renderJsonItem(item: LightboxItem) {
    void this._mdCacheVersion;
    this._ensureTextPreview(item.url, 'json');
    const entry = this._mdCache.get(item.url);
    return html`
      <div class="ml-md-shell">
        <div class="ml-toolbar ml-md-toolbar">
          <span class="ml-count">${item.path}</span>
          <a class="ml-btn" href=${item.url} target="_blank" rel="noopener">Open raw</a>
        </div>
        <div class="ml-md-body">
          ${entry?.status === 'loading' || !entry
            ? html`<div class="ml-fallback">Loading…</div>`
            : entry.status === 'err'
              ? html`<div class="ml-fallback ml-broken">Failed to load: ${entry.error}</div>`
              : html`<pre class="ml-json-content">${entry.data}</pre>`}
        </div>
      </div>
    `;
  }

  private _renderDiffItem(item: LightboxItem) {
    void this._mdCacheVersion;
    this._ensureTextPreview(item.url, 'diff');
    const entry = this._mdCache.get(item.url);
    return html`
      <div class="ml-diff-shell">
        <div class="ml-toolbar ml-md-toolbar">
          <span class="ml-count">${item.path}</span>
          <a class="ml-btn" href=${item.url} target="_blank" rel="noopener">Open raw</a>
        </div>
        <div class="ml-diff-body">
          ${entry?.status === 'loading' || !entry
            ? html`<div class="ml-fallback">Loading…</div>`
            : entry.status === 'err'
              ? html`<div class="ml-fallback ml-broken">Failed to load: ${entry.error}</div>`
              : html`<diff-review .diff=${entry.data} .filename=${item.path}></diff-review>`}
        </div>
      </div>
    `;
  }

  private _renderImagePair(pair: LightboxPair) {
    const isSlider = this._imageCompareLayout === 'slider';
    return html`
      ${isSlider
        ? html`
            <div
              class="ml-cmp-stage"
              @pointerdown=${(e: PointerEvent) => this._onDividerDown(e)}
              @pointermove=${(e: PointerEvent) => this._onDividerMove(e)}
              @pointerup=${(e: PointerEvent) => this._onDividerUp(e)}
              @pointercancel=${(e: PointerEvent) => this._onDividerUp(e)}
            >
              <img
                class="ml-cmp-img ml-cmp-before"
                src=${pair.before.url}
                alt=${pair.before.path}
              />
              <img
                class="ml-cmp-img ml-cmp-after"
                src=${pair.after.url}
                alt=${pair.after.path}
                style=${`clip-path: inset(0 0 0 ${this._divider}%);`}
              />
              <div class="ml-cmp-divider" style=${`left: ${this._divider}%;`}>
                <div class="ml-cmp-handle">⇆</div>
              </div>
              <div class="ml-cmp-label ml-cmp-label-l">BEFORE</div>
              <div class="ml-cmp-label ml-cmp-label-r">AFTER</div>
            </div>
          `
        : html`
            <div class="ml-cmp-image-grid">
              <div class="ml-cmp-image-cell">
                <div class="ml-cmp-label ml-cmp-label-static">BEFORE</div>
                <img class="ml-cmp-img-side" src=${pair.before.url} alt=${pair.before.path} />
              </div>
              <div class="ml-cmp-image-cell">
                <div class="ml-cmp-label ml-cmp-label-static">AFTER</div>
                <img class="ml-cmp-img-side" src=${pair.after.url} alt=${pair.after.path} />
              </div>
            </div>
          `}
      <div class="ml-toolbar">
        <button
          class="ml-btn ${isSlider ? 'active' : ''}"
          @click=${() => {
            this._imageCompareLayout = 'slider';
          }}
          title="Slider overlay (drag to reveal)"
        >
          Slider
        </button>
        <button
          class="ml-btn ${!isSlider ? 'active' : ''}"
          @click=${() => {
            this._imageCompareLayout = 'side-by-side';
          }}
          title="Side-by-side panels"
        >
          Side-by-side
        </button>
        ${isSlider
          ? html`
              <span class="ml-count">Divider ${Math.round(this._divider)}%</span>
              <button
                class="ml-btn"
                @click=${() => {
                  this._divider = 50;
                }}
              >
                Center
              </button>
              <button
                class="ml-btn"
                @click=${() => {
                  this._divider = 0;
                }}
              >
                Full After
              </button>
              <button
                class="ml-btn"
                @click=${() => {
                  this._divider = 100;
                }}
              >
                Full Before
              </button>
            `
          : nothing}
      </div>
    `;
  }

  private _renderVideoPair(pair: LightboxPair) {
    return html`
      <div class="ml-cmp-video-grid">
        <div class="ml-cmp-video-cell">
          <div class="ml-cmp-label ml-cmp-label-static">BEFORE</div>
          <video
            class="ml-cmp-video a"
            src=${pair.before.url}
            preload="metadata"
            @loadedmetadata=${() => this._syncPrimaryVideoState()}
            @timeupdate=${() => this._syncPrimaryVideoState()}
            @play=${() => this._syncPrimaryVideoState()}
            @pause=${() => this._syncPrimaryVideoState()}
            @ratechange=${() => this._syncPrimaryVideoState()}
            @seeked=${() => this._syncPrimaryVideoState()}
            @ended=${() => this._pauseVideoPlayback()}
          ></video>
        </div>
        <div class="ml-cmp-video-cell">
          <div class="ml-cmp-label ml-cmp-label-static">AFTER</div>
          <video
            class="ml-cmp-video b"
            src=${pair.after.url}
            preload="metadata"
            @loadedmetadata=${() => this._syncPrimaryVideoState()}
            @timeupdate=${() => this._syncPrimaryVideoState()}
            @play=${() => this._syncPrimaryVideoState()}
            @pause=${() => this._syncPrimaryVideoState()}
            @ratechange=${() => this._syncPrimaryVideoState()}
            @seeked=${() => this._syncPrimaryVideoState()}
            @ended=${() => this._pauseVideoPlayback()}
          ></video>
        </div>
      </div>
      ${this._renderVideoControls(true)}
    `;
  }

  static styles = mediaLightboxStyles;
}

declare global {
  interface HTMLElementTagNameMap {
    'media-lightbox': MediaLightbox;
  }
}
