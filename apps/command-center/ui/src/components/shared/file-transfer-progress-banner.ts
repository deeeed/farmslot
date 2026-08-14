import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { type FileTransferProgress, Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

import {
  type FileTransferUiEntry,
  formatTransferBytes,
  transferPercent,
} from './file-transfer-progress-model.js';
import {
  clearCompletedFileTransfers,
  getFileTransfersForRun,
  retainFileTransferStore,
  subscribeFileTransferStore,
} from './file-transfer-progress-store.js';

@customElement('file-transfer-progress-banner')
export class FileTransferProgressBanner extends LitElement {
  /** When set, only show transfers for this run (run-detail embed). */
  @property({ type: String, attribute: 'run-id' }) runId = '';
  /** Inline layout for run-detail instead of fixed corner toast. */
  @property({ type: Boolean }) inline = false;

  @state() private _entries: FileTransferUiEntry[] = [];
  @state() private _cancelBusy: string | null = null;

  private _unsubStore: (() => void) | null = null;
  private _releaseStore: (() => void) | null = null;

  static override styles = css`
    :host {
      display: block;
      pointer-events: none;
      font-family: ${unsafeCSS(fonts.mono)};
    }
    :host(:not([inline])) {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 1200;
      max-width: min(420px, calc(100vw - 32px));
    }
    :host([inline]) {
      pointer-events: auto;
      margin: ${unsafeCSS(spacing.sm)} 0;
      max-width: 100%;
    }
    .ftp-stack {
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: auto;
    }
    .ftp-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
    }
    .ftp-card {
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgCard)};
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    }
    :host([inline]) .ftp-card {
      box-shadow: none;
    }
    .ftp-header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 6px;
    }
    .ftp-title {
      font-size: ${unsafeCSS(fonts.sizeSm)};
      font-weight: 700;
      color: ${unsafeCSS(colors.textPrimary)};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ftp-meta {
      font-size: 11px;
      color: ${unsafeCSS(colors.textMuted)};
      white-space: nowrap;
    }
    .ftp-status {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 2px 7px;
      border-radius: ${unsafeCSS(radii.sm)};
    }
    .ftp-status.running {
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
    }
    .ftp-status.done {
      background: ${unsafeCSS(colors.statusOk)}22;
      color: ${unsafeCSS(colors.statusOk)};
    }
    .ftp-status.failed,
    .ftp-status.cancelled {
      background: ${unsafeCSS(colors.statusFail)}22;
      color: ${unsafeCSS(colors.statusFail)};
    }
    .ftp-bar {
      width: 100%;
      height: 8px;
      border-radius: 999px;
      background: #1a1a2e;
      overflow: hidden;
    }
    .ftp-bar > span {
      display: block;
      height: 100%;
      background: ${unsafeCSS(colors.accent)};
      transition: width 120ms linear;
    }
    .ftp-bar.failed > span,
    .ftp-bar.cancelled > span {
      background: ${unsafeCSS(colors.statusFail)};
    }
    .ftp-bar.done > span {
      background: ${unsafeCSS(colors.statusOk)};
    }
    .ftp-error {
      margin-top: 6px;
      font-size: 11px;
      color: ${unsafeCSS(colors.statusFail)};
      line-height: 1.35;
      word-break: break-word;
    }
    .ftp-phase {
      font-size: 10px;
      color: ${unsafeCSS(colors.textSecondary)};
      margin-top: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .ftp-cancel {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border: 1px solid #4a4a66;
      background: transparent;
      color: ${unsafeCSS(colors.textSecondary)};
      border-radius: ${unsafeCSS(radii.sm)};
      padding: 2px 8px;
      cursor: pointer;
    }
    .ftp-cancel:hover {
      color: ${unsafeCSS(colors.statusFail)};
      border-color: ${unsafeCSS(colors.statusFail)};
    }
    .ftp-cancel:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this._releaseStore = retainFileTransferStore();
    this._unsubStore = subscribeFileTransferStore(() => this._syncFromStore());
    this._syncFromStore();
  }

  override disconnectedCallback(): void {
    this._unsubStore?.();
    this._unsubStore = null;
    this._releaseStore?.();
    this._releaseStore = null;
    super.disconnectedCallback();
  }

  override willUpdate(changed: Map<string | number | symbol, unknown>): void {
    // Reused inline run-detail hosts change run-id without reconnecting.
    if (changed.has('runId')) this._syncFromStore();
  }

  private _syncFromStore(): void {
    this._entries = getFileTransfersForRun(this.runId || null);
  }

  private async _cancel(transferId: string): Promise<void> {
    this._cancelBusy = transferId;
    try {
      await gateway.request(Methods.FILE_TRANSFER_CANCEL, { transferId });
    } finally {
      this._cancelBusy = null;
    }
  }

  override render() {
    const entries = this._entries;
    if (entries.length === 0) return nothing;
    // Directory mirrors already publish one aggregate entry with file/byte progress.
    // Rendering each child duplicates that progress and floods the operator surface.
    const visibleEntries = entries.filter(
      (entry) => !entry.parentTransferId || entry.state === 'failed' || entry.state === 'cancelled',
    );
    if (visibleEntries.length === 0) return nothing;
    const completedCount = visibleEntries.filter((entry) => entry.state === 'done').length;
    const detailedEntries = visibleEntries.filter((entry) => entry.state !== 'done');
    return html`
      <div
        class="ftp-stack"
        data-testid=${this.inline
          ? 'file-transfer-progress-inline'
          : 'file-transfer-progress-banner'}
      >
        ${completedCount > 0
          ? html`<div class="ftp-toolbar">
              <span>${completedCount} completed transfer${completedCount === 1 ? '' : 's'}</span>
              <button
                class="ftp-cancel"
                data-testid="file-transfer-clear-completed"
                @click=${() => clearCompletedFileTransfers(this.runId || null)}
              >
                clear completed
              </button>
            </div>`
          : nothing}
        ${detailedEntries.map((entry) => this._renderCard(entry))}
      </div>
    `;
  }

  private _renderCard(entry: FileTransferUiEntry) {
    const pct = transferPercent(entry);
    const name = entry.label || entry.path.split('/').pop() || entry.path;
    const files =
      entry.filesTotal != null && entry.filesTotal > 0
        ? ` · file ${entry.filesCompleted ?? 0}/${entry.filesTotal}`
        : '';
    return html`
      <div
        class="ftp-card"
        data-testid="file-transfer-progress-card"
        data-transfer-id=${entry.transferId}
        data-state=${entry.state}
        data-phase=${entry.phase}
      >
        <div class="ftp-header">
          <div class="ftp-title" title=${entry.path}>${name}</div>
          <span class="ftp-status ${entry.state}">${entry.state}</span>
        </div>
        <div class="ftp-meta">
          ${formatTransferBytes(entry.bytesTransferred)} / ${formatTransferBytes(entry.totalBytes)}
          (${pct}%)${files}
        </div>
        <div
          class="ftp-bar ${entry.state}"
          role="progressbar"
          aria-valuenow=${pct}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span style="width: ${pct}%"></span>
        </div>
        <div class="ftp-phase">
          <span
            >phase: ${entry.phase}${entry.runId ? ` · run ${entry.runId.slice(0, 8)}` : ''}</span
          >
          ${entry.state === 'running' && entry.cancellable !== false
            ? html`<button
                class="ftp-cancel"
                data-testid="file-transfer-cancel"
                ?disabled=${this._cancelBusy === entry.transferId}
                @click=${() => void this._cancel(entry.transferId)}
              >
                cancel
              </button>`
            : nothing}
        </div>
        ${entry.error
          ? html`<div class="ftp-error" data-testid="file-transfer-progress-error">
              ${entry.error}
            </div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'file-transfer-progress-banner': FileTransferProgressBanner;
  }
}

// Keep type import used for documentation / future typed casts
export type { FileTransferProgress };
