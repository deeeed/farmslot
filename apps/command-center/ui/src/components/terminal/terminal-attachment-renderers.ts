import { css, html, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

import {
  formatAttachmentSize,
  isTerminalAttachmentActive,
  isTerminalAttachmentRetryable,
  type TerminalAttachment,
  terminalAttachmentStatusLabel,
} from './terminal-attachment-model.js';

export interface TerminalAttachmentTrayContext {
  attachments: TerminalAttachment[];
  dragActive: boolean;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}

export function renderTerminalDropOverlay(dragActive: boolean) {
  if (!dragActive) return '';
  return html`<div class="attachment-drop-overlay" data-testid="terminal-attachment-drop-overlay">
    <span>Drop image to attach</span>
  </div>`;
}

export function renderTerminalAttachmentTray(ctx: TerminalAttachmentTrayContext) {
  if (ctx.attachments.length === 0) return '';
  return html`
    <div class="attachment-tray" data-testid="terminal-attachment-tray">
      ${ctx.attachments.map((attachment) => renderAttachmentCard(attachment, ctx))}
    </div>
  `;
}

function renderAttachmentCard(attachment: TerminalAttachment, ctx: TerminalAttachmentTrayContext) {
  const active = isTerminalAttachmentActive(attachment);
  return html`
    <div
      class="attachment-card phase-${attachment.phase}"
      data-testid="terminal-attachment-card"
      data-attachment-phase=${attachment.phase}
    >
      ${attachment.previewUrl
        ? html`<img
            class="attachment-thumb"
            src=${attachment.previewUrl}
            alt=${attachment.filename}
          />`
        : html`<div class="attachment-thumb attachment-thumb-empty" aria-hidden="true">?</div>`}
      <div class="attachment-body">
        <div class="attachment-line">
          <span class="attachment-name" title=${attachment.filename}>${attachment.filename}</span>
          <span class="attachment-size">${formatAttachmentSize(attachment.byteLength)}</span>
        </div>
        <div class="attachment-line">
          <span class="attachment-status" data-testid="terminal-attachment-status"
            >${terminalAttachmentStatusLabel(attachment)}</span
          >
          ${attachment.runner
            ? html`<span class="attachment-runner">${attachment.runner}</span>`
            : ''}
        </div>
        <progress
          class="attachment-progress"
          max="100"
          .value=${attachment.uploadPercent}
          data-testid="terminal-attachment-progress"
        ></progress>
        ${attachment.detail
          ? html`<div class="attachment-detail" data-testid="terminal-attachment-detail">
              ${attachment.detail}
            </div>`
          : ''}
      </div>
      <div class="attachment-actions">
        ${isTerminalAttachmentRetryable(attachment)
          ? html`<button
              class="attachment-btn"
              data-testid="terminal-attachment-retry"
              @click=${() => ctx.onRetry(attachment.id)}
            >
              Retry
            </button>`
          : ''}
        <button
          class="attachment-btn"
          data-testid="terminal-attachment-remove"
          ?disabled=${active}
          title=${active ? 'Wait for the transfer to settle before removing' : 'Remove attachment'}
          @click=${() => ctx.onRemove(attachment.id)}
        >
          Remove
        </button>
      </div>
    </div>
  `;
}

export const terminalAttachmentStyles = css`
  .attachment-tray {
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.sm)};
    padding: ${unsafeCSS(spacing.md)};
    background: ${unsafeCSS(colors.bgCard)};
    border-top: 1px solid #1e1e36;
    flex-shrink: 0;
    /* Several attachments must not push the terminal itself off screen. */
    max-height: 180px;
    overflow-y: auto;
  }

  .attachment-card {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.md)};
    padding: ${unsafeCSS(spacing.md)};
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid #1e1e36;
    border-left: 3px solid ${unsafeCSS(colors.accent)};
    border-radius: ${unsafeCSS(radii.sm)};
  }

  .attachment-card.phase-attached {
    border-left-color: ${unsafeCSS(colors.statusOk)};
  }

  .attachment-card.phase-failed {
    border-left-color: ${unsafeCSS(colors.statusFail)};
  }

  .attachment-card.phase-unsupported {
    border-left-color: ${unsafeCSS(colors.statusWarn)};
  }

  .attachment-thumb-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeMd)};
    color: ${unsafeCSS(colors.textMuted)};
  }

  .attachment-thumb {
    width: 44px;
    height: 44px;
    object-fit: cover;
    border-radius: ${unsafeCSS(radii.sm)};
    background: #0a0a0f;
    flex-shrink: 0;
  }

  .attachment-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .attachment-line {
    display: flex;
    align-items: baseline;
    gap: ${unsafeCSS(spacing.md)};
    min-width: 0;
  }

  .attachment-name {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    color: ${unsafeCSS(colors.textPrimary)};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-size,
  .attachment-runner {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textMuted)};
  }

  .attachment-status {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textSecondary)};
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .phase-attached .attachment-status {
    color: ${unsafeCSS(colors.statusOk)};
  }

  .phase-failed .attachment-status {
    color: ${unsafeCSS(colors.statusFail)};
  }

  .phase-unsupported .attachment-status {
    color: ${unsafeCSS(colors.statusWarn)};
  }

  .attachment-progress {
    width: 100%;
    height: 4px;
    appearance: none;
  }

  .attachment-progress::-webkit-progress-bar {
    background: #1e1e36;
    border-radius: 2px;
  }

  .attachment-progress::-webkit-progress-value {
    background: ${unsafeCSS(colors.accent)};
    border-radius: 2px;
  }

  .attachment-detail {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textMuted)};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-actions {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    flex-shrink: 0;
  }

  .attachment-btn {
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid #2a2a45;
    color: ${unsafeCSS(colors.textSecondary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    padding: 3px 8px;
    border-radius: ${unsafeCSS(radii.sm)};
    cursor: pointer;
  }

  .attachment-btn:hover:not(:disabled) {
    border-color: ${unsafeCSS(colors.accent)};
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .attachment-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .attachment-drop-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(99, 102, 241, 0.18);
    border: 2px dashed ${unsafeCSS(colors.accent)};
    border-radius: ${unsafeCSS(radii.sm)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    color: ${unsafeCSS(colors.textPrimary)};
    z-index: 6;
    pointer-events: none;
  }
`;
