// <stream-feed> — renders H.264 screen stream to canvas via WebCodecs

import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { Methods } from '@farmslot/protocol';

import type { MockH264Source } from '../../dev/mock-h264-source.js';
import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

import { decodeStreamFrame } from './binary-codec.js';
import { H264Decoder } from './h264-decoder.js';

let instanceSeq = 0;
const STREAM_SUBSCRIBE_TIMEOUT_MS = 90_000;

@customElement('stream-feed')
export class StreamFeed extends LitElement {
  @property() slotId = '';
  @property() platform: 'ios' | 'android' | 'chrome-extension' | '' = '';
  @property() resourceId = '';
  @property({ type: Number }) resourceIndex = -1; // -1 = accept all frames (backward compat)
  @property({ attribute: false }) mockSource?: MockH264Source;

  @state() private _width = 0;
  @state() private _height = 0;
  @state() private _fps = 0;
  @state() private _paused = false;
  @state() private _frameCount = 0;
  @state() private _error = '';

  private _decoder: H264Decoder | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _ctx: CanvasRenderingContext2D | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _pendingFrame: VideoFrame | null = null;
  private _rafId = 0;
  private _instanceId = ++instanceSeq;
  private _fpsTimestamps: number[] = [];
  private _fpsInterval: ReturnType<typeof setInterval> | null = null;
  private _boundOnChunk: ((data: Uint8Array, keyFrame: boolean, timestamp: number) => void) | null =
    null;
  private _unsubBinary: (() => void) | null = null;
  private _subscribed = false;
  private _subscriptionReady = false;
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;

  private _log(action: string, detail?: string) {
    const parts = [`[stream-feed #${this._instanceId}] ${action}`];
    if (this.slotId) parts.push(`slot=${this.slotId}`);
    if (detail) parts.push(detail);
    console.log(parts.join(' '));
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid #1e1e36;
      border-radius: ${unsafeCSS(radii.md)};
      overflow: hidden;
      min-height: 120px;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.bgCard)};
      border-bottom: 1px solid #1e1e36;
      flex-shrink: 0;
    }

    .toolbar-label {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
    }

    .toolbar-value {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textSecondary)};
    }

    .toolbar-spacer {
      flex: 1;
    }

    .toolbar-btn {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      padding: 2px 8px;
      border: 1px solid #2a2a44;
      border-radius: 3px;
      background: transparent;
      color: ${unsafeCSS(colors.textSecondary)};
      cursor: pointer;
      transition: all 0.1s;
    }

    .toolbar-btn:hover {
      background: rgba(99, 102, 241, 0.12);
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .toolbar-btn.active {
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)}44;
    }

    .canvas-wrap {
      flex: 1;
      position: relative;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
    }

    canvas {
      display: block;
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }

    .no-support {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      padding: ${unsafeCSS(spacing.xl)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.statusWarn)};
      text-align: center;
    }

    .error-msg {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.statusFail)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.statusFail)}0a;
      border-top: 1px solid ${unsafeCSS(colors.statusFail)}22;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: ${unsafeCSS(spacing.md)};
      flex: 1;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }

    .empty-icon {
      font-size: 32px;
      opacity: 0.3;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._log('connectedCallback');
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._log('disconnectedCallback');
    this._dispose();
  }

  firstUpdated() {
    this._canvas = this.shadowRoot!.querySelector('canvas');
    if (this._canvas) {
      this._ctx = this._canvas.getContext('2d');
    }

    if (!H264Decoder.isSupported()) {
      this._error = 'WebCodecs not supported — use Chrome or Edge';
      return;
    }

    this._setupDecoder();
    this._setupResizeObserver();
    this._setupMockSource();
    this._startFpsCounter();
    this._subscribeGateway();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('mockSource') && this._decoder) {
      this._setupMockSource();
    }
    if (
      (changed.has('slotId') || changed.has('platform') || changed.has('resourceId')) &&
      !this.mockSource
    ) {
      this._unsubscribeGateway();
      this._setupDecoder();
      this._frameCount = 0;
      this._error = '';
      this._subscribeGateway();
    }
  }

  private _setupDecoder() {
    this._decoder?.close();
    this._decoder = new H264Decoder(
      (frame: VideoFrame) => this._onVideoFrame(frame),
      (err: Error) => {
        this._log('decoder-error', err.message);
        this._error = err.message;
        if (!this._paused) {
          this._log('decoder-recover');
          this._setupDecoder();
        }
      },
    );
  }

  private _setupMockSource() {
    if (!this.mockSource || !this._decoder) return;

    // Wire mock source's onChunk to our decoder
    this._boundOnChunk = (data: Uint8Array, keyFrame: boolean, timestamp: number) => {
      if (!this._decoder) return;
      this._decoder.decode(data, timestamp, keyFrame);
    };

    // The mock source calls onChunk from its constructor options,
    // so we need to create a new source or monkey-patch the callback.
    // Since MockH264Source takes onChunk in constructor, the dev harness
    // passes it and we set up the wiring there. Here we just store the ref.
    this._log('mock-source-wired');
  }

  private _onVideoFrame(frame: VideoFrame) {
    if (this._error) {
      this._error = '';
    }
    // Track dimensions
    if (frame.displayWidth !== this._width || frame.displayHeight !== this._height) {
      this._width = frame.displayWidth;
      this._height = frame.displayHeight;
      if (this._canvas) {
        this._canvas.width = frame.displayWidth;
        this._canvas.height = frame.displayHeight;
      }
    }

    // Track FPS
    this._fpsTimestamps.push(performance.now());
    this._frameCount++;

    // Close previous pending frame (prevent GPU memory leak)
    if (this._pendingFrame) {
      this._pendingFrame.close();
    }
    this._pendingFrame = frame;

    // Schedule draw on next animation frame (drop intermediate frames)
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => this._drawFrame());
    }
  }

  private _drawFrame() {
    this._rafId = 0;
    const frame = this._pendingFrame;
    if (!frame || !this._ctx || !this._canvas) {
      if (frame) frame.close();
      this._pendingFrame = null;
      return;
    }

    this._ctx.drawImage(frame, 0, 0, this._canvas.width, this._canvas.height);
    frame.close();
    this._pendingFrame = null;
  }

  private _setupResizeObserver() {
    const wrap = this.shadowRoot!.querySelector('.canvas-wrap');
    if (!wrap) return;

    this._resizeObserver = new ResizeObserver(() => {
      // Canvas aspect ratio is managed by CSS object-fit
    });
    this._resizeObserver.observe(wrap);
  }

  private _startFpsCounter() {
    this._fpsInterval = setInterval(() => {
      const now = performance.now();
      // Keep only last second of timestamps
      this._fpsTimestamps = this._fpsTimestamps.filter((t) => now - t < 1000);
      this._fps = this._fpsTimestamps.length;
    }, 500);
  }

  private _togglePause() {
    this._paused = !this._paused;
    if (this._paused) {
      this._unsubscribeGateway();
    } else {
      this._setupDecoder(); // fresh decoder — needs keyframe after resubscribe
      this._subscribeGateway();
    }
    this._log(this._paused ? 'paused (unsubscribed)' : 'resumed (resubscribed)');
  }

  private _snapshot() {
    if (!this._canvas) return;
    this._canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stream-${this.slotId || 'snapshot'}-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  private _dispose() {
    this._unsubscribeGateway();
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
    if (this._pendingFrame) {
      this._pendingFrame.close();
      this._pendingFrame = null;
    }
    this._decoder?.close();
    this._decoder = null;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    if (this._fpsInterval) {
      clearInterval(this._fpsInterval);
      this._fpsInterval = null;
    }
  }

  private _subscribeGateway() {
    if (this._subscribed || !this.slotId || this.mockSource) return;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._subscriptionReady = false;
    this._log('subscribing to gateway');
    this._unsubBinary = gateway.onBinary((buf: ArrayBuffer) => {
      if (!this._decoder || !this._subscriptionReady) return;
      try {
        const frame = decodeStreamFrame(buf);
        // Filter by resourceIndex if set (-1 = accept all for backward compat)
        if (this.resourceIndex >= 0 && frame.resourceIndex !== this.resourceIndex) return;
        this._decoder.decode(frame.payload, frame.timestampMs, frame.keyFrame);
      } catch {
        /* malformed frame */
      }
    });
    const params: Record<string, unknown> = { slotId: this.slotId };
    if (this.platform) params.platform = this.platform;
    if (this.resourceId) params.resourceId = this.resourceId;
    gateway
      .request(Methods.STREAM_SUBSCRIBE, params, STREAM_SUBSCRIBE_TIMEOUT_MS)
      .then((res) => {
        // Always use server-assigned resourceIndex (server is source of truth)
        const result = res as { ok: boolean; resourceIndex?: number };
        if (typeof result.resourceIndex === 'number') {
          this.resourceIndex = result.resourceIndex;
          this._log('assigned-resource-index', `idx=${result.resourceIndex}`);
        } else {
          this.resourceIndex = -1;
        }
        this._subscriptionReady = true;
        this._error = '';
      })
      .catch((err) => {
        this._log('subscribe-error', (err as Error).message);
        this._error = `Feed error: ${(err as Error).message}`;
        // Tear down binary listener — no valid subscription, don't decode stale frames
        this._unsubBinary?.();
        this._unsubBinary = null;
        this._subscribed = false;
        if (!this._paused && /timeout|timed out/i.test((err as Error).message)) {
          this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            this._error = '';
            this._subscribeGateway();
          }, 1500);
        }
      });
    this._subscribed = true;
  }

  private _unsubscribeGateway() {
    if (!this._subscribed) return;
    this._subscriptionReady = false;
    this._log('unsubscribing from gateway');
    this._unsubBinary?.();
    this._unsubBinary = null;
    gateway
      .request(Methods.STREAM_UNSUBSCRIBE, {
        slotId: this.slotId,
        ...(this.platform ? { platform: this.platform } : {}),
        ...(this.resourceId ? { resourceId: this.resourceId } : {}),
      })
      .catch(() => {});
    this._subscribed = false;
  }

  // Public method for feeding chunks from outside (dev harness wiring)
  feedChunk(data: Uint8Array, keyFrame: boolean, timestamp: number) {
    if (!this._decoder) return;
    this._decoder.decode(data, timestamp, keyFrame);
  }

  render() {
    if (!H264Decoder.isSupported()) {
      return html`
        <div class="toolbar">
          <span class="toolbar-label">Stream</span>
        </div>
        <div class="no-support">WebCodecs not supported. Use Chrome or Edge.</div>
      `;
    }

    return html`
      <div class="toolbar">
        <span class="toolbar-label">${this.slotId || 'Stream'}</span>
        ${this._width > 0
          ? html` <span class="toolbar-value">${this._width}x${this._height}</span> `
          : ''}
        <span class="toolbar-value">${this._fps} fps</span>
        <span class="toolbar-value">#${this._frameCount}</span>
        <span class="toolbar-spacer"></span>
        <button class="toolbar-btn ${this._paused ? 'active' : ''}" @click=${this._togglePause}>
          ${this._paused ? 'Resume' : 'Pause'}
        </button>
        <button class="toolbar-btn" @click=${this._snapshot}>Snapshot</button>
      </div>
      <div class="canvas-wrap">
        ${this._frameCount === 0
          ? html`
              <div class="empty-state">
                <div class="empty-icon">&#9654;</div>
                <span>${this._subscriptionReady ? 'Waiting for frames...' : 'Subscribing...'}</span>
              </div>
            `
          : ''}
        <canvas
          width=${this._width || 360}
          height=${this._height || 780}
          style="display: ${this._frameCount === 0 ? 'none' : 'block'}"
        ></canvas>
      </div>
      ${this._error ? html`<div class="error-msg">${this._error}</div>` : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'stream-feed': StreamFeed;
  }
}
