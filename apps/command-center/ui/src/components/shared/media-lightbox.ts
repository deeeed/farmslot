// <media-lightbox> — Shared fullscreen artifact viewer.
// Single mode: zoom, pan, keyboard nav, filmstrip.
// Compare mode: image slider overlay + synced two-pane video.
// Used by family-observability and review-workspace.

import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import '../diff-viewer/diff-review.js';

import { type ArtifactKind, artifactKind } from '../../utils/artifact-kind.js';
import { gatewayHttpOrigin } from '../../utils/gateway-origin.js';
import { putCapped } from '../../utils/markdown.js';

import {
  isVideoLightboxItem,
  mediaLightboxFileType,
  mediaLightboxFileTypeBadge,
} from './media-lightbox-model.js';
import {
  formatLightboxTextPreview,
  type MediaLightboxTextPreviewKind,
  sameOriginLightboxFetchUrl,
} from './media-lightbox-preview-model.js';
import { MD_CACHE_LIMIT, MediaLightboxState } from './media-lightbox-state.js';
import { mediaLightboxStyles } from './media-lightbox-styles.js';
import type { LightboxItem, LightboxPair } from './media-lightbox-types.js';

@customElement('media-lightbox')
export class MediaLightbox extends MediaLightboxState {
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKeyDown);
    this._mdCache.clear();
  }

  updated(changed: Map<string, unknown>): void {
    if (
      changed.has('selectedIndex') ||
      changed.has('open') ||
      changed.has('pairIndex') ||
      changed.has('mode')
    ) {
      this._resetView();
      this._divider = 50;
    }
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
    this.dispatchEvent(new CustomEvent('lightbox-close'));
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
        e.preventDefault();
        const a = this.renderRoot.querySelector<HTMLVideoElement>('.ml-cmp-video.a');
        if (!a) return;
        if (a.paused) void a.play();
        else a.pause();
      } else {
        const item = this.items[this.selectedIndex];
        if (!item || !isVideoLightboxItem(item)) return;
        e.preventDefault();
        const video = this.renderRoot.querySelector<HTMLVideoElement>('.ml-video');
        if (video) {
          if (video.paused) void video.play();
          else video.pause();
        }
      }
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
      <div class="ml-backdrop" @click=${() => this._close()}>
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
              <button class="ml-btn" @click=${() => this._close()}>Close</button>
            </div>
          </div>
          <div class="ml-body">
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
                  ? html`<video
                      class="ml-expanded ml-video"
                      src=${item.url}
                      controls
                      autoplay
                      preload="metadata"
                      @error=${() => this._markBroken(selectedIdx)}
                    ></video>`
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
      <div class="ml-backdrop" @click=${() => this._close()}>
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

  private _sameOriginUrl(url: string): string {
    return sameOriginLightboxFetchUrl({
      url,
      locationHref: window.location.href,
      windowOrigin: window.location.origin,
      gatewayOrigin: gatewayHttpOrigin(),
    });
  }

  private _ensureTextPreview(url: string, kind: MediaLightboxTextPreviewKind): void {
    if (this._mdCache.has(url)) return;
    putCapped(this._mdCache, url, { status: 'loading' }, MD_CACHE_LIMIT);
    const fetchUrl = this._sameOriginUrl(url);
    fetch(fetchUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        putCapped(
          this._mdCache,
          url,
          { status: 'ok', data: formatLightboxTextPreview(kind, text) },
          MD_CACHE_LIMIT,
        );
        this._mdCacheVersion += 1;
      })
      .catch((err: Error) => {
        putCapped(this._mdCache, url, { status: 'err', error: err.message }, MD_CACHE_LIMIT);
        this._mdCacheVersion += 1;
      });
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
              : html`<div class="ml-md-content">${unsafeHTML(entry.data)}</div>`}
        </div>
      </div>
    `;
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
          <video class="ml-cmp-video a" src=${pair.before.url} controls preload="metadata"></video>
        </div>
        <div class="ml-cmp-video-cell">
          <div class="ml-cmp-label ml-cmp-label-static">AFTER</div>
          <video class="ml-cmp-video b" src=${pair.after.url} controls preload="metadata"></video>
        </div>
      </div>
      <div class="ml-toolbar">
        <span class="ml-count">Synced playback · Space to play/pause · ← → next pair</span>
      </div>
    `;
  }

  static styles = mediaLightboxStyles;
}

declare global {
  interface HTMLElementTagNameMap {
    'media-lightbox': MediaLightbox;
  }
}
