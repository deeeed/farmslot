// Dev harness fixtures for the terminal image-attachment states. Renders the real tray
// renderer so every lifecycle state is reviewable without a live upload.

import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type { TerminalAttachment } from '../components/terminal/terminal-attachment-model.js';
import {
  renderTerminalAttachmentTray,
  renderTerminalDropOverlay,
  terminalAttachmentStyles,
} from '../components/terminal/terminal-attachment-renderers.js';
import { colors, fonts, spacing } from '../styles/theme-tokens.js';

const PREVIEW_SRC =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88"><rect width="88" height="88" fill="#1b1b30"/><circle cx="30" cy="30" r="14" fill="#6366f1"/><path d="M6 82 L38 42 L60 68 L74 52 L86 82 Z" fill="#00ff88"/></svg>`,
  );

function fixture(overrides: Partial<TerminalAttachment>): TerminalAttachment {
  return {
    id: overrides.id ?? 'fixture',
    filename: 'screenshot-2026-08-04.png',
    mimeType: 'image/png',
    byteLength: 248_312,
    previewUrl: PREVIEW_SRC,
    phase: 'uploading',
    uploadPercent: 0,
    detail: '',
    ...overrides,
  };
}

const FIXTURES: Array<{ label: string; attachments: TerminalAttachment[]; dragActive: boolean }> = [
  { label: 'Idle drag target', attachments: [], dragActive: true },
  {
    label: 'Uploading (determinate progress)',
    dragActive: false,
    attachments: [fixture({ id: 'uploading', phase: 'uploading', uploadPercent: 42 })],
  },
  {
    label: 'Uploaded to slot — runner has NOT received it',
    dragActive: false,
    attachments: [fixture({ id: 'uploaded', phase: 'uploaded', uploadPercent: 100 })],
  },
  {
    label: 'Runner delivery in flight',
    dragActive: false,
    attachments: [
      fixture({ id: 'delivering', phase: 'delivering', uploadPercent: 100, runner: 'claude' }),
    ],
  },
  {
    label: 'Delivered',
    dragActive: false,
    attachments: [
      fixture({
        id: 'attached',
        phase: 'attached',
        uploadPercent: 100,
        runner: 'codex',
        detail: 'Delivered screenshot-2026-08-04.png to codex',
      }),
    ],
  },
  {
    label: 'Unsupported runner',
    dragActive: false,
    attachments: [
      fixture({
        id: 'unsupported',
        phase: 'unsupported',
        uploadPercent: 100,
        runner: 'opencode',
        detail: 'Runner opencode has no verified image attachment support',
      }),
    ],
  },
  {
    label: 'Retryable failure',
    dragActive: false,
    attachments: [
      fixture({
        id: 'failed',
        phase: 'failed',
        uploadPercent: 66,
        detail: 'Attachment is 12.0 MB — the limit is 8.0 MB',
      }),
    ],
  },
];

@customElement('terminal-attachment-dev')
export class TerminalAttachmentDev extends LitElement {
  static styles = [
    terminalAttachmentStyles,
    css`
      :host {
        display: block;
      }

      .fixture-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
        gap: ${unsafeCSS(spacing.lg)};
      }

      .fixture-label {
        font-family: ${unsafeCSS(fonts.mono)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        color: ${unsafeCSS(colors.textSecondary)};
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: ${unsafeCSS(spacing.sm)};
      }

      .fixture-surface {
        position: relative;
        min-height: 44px;
        border: 1px solid #1e1e36;
        border-radius: 6px;
        background: ${unsafeCSS(colors.bgSurface)};
        overflow: hidden;
      }

      .fixture-terminal {
        height: 28px;
        font-family: ${unsafeCSS(fonts.mono)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        color: ${unsafeCSS(colors.textMuted)};
        padding: ${unsafeCSS(spacing.md)};
      }

      .last-action {
        font-family: ${unsafeCSS(fonts.mono)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        color: ${unsafeCSS(colors.accent)};
        margin-bottom: ${unsafeCSS(spacing.md)};
      }
    `,
  ];

  @state() private lastAction = 'no action yet';

  render() {
    return html`
      <div class="last-action" data-testid="terminal-attachment-dev-action">${this.lastAction}</div>
      <div class="fixture-grid">
        ${FIXTURES.map(
          (item) => html`
            <div class="fixture">
              <div class="fixture-label">${item.label}</div>
              <div class="fixture-surface">
                <div class="fixture-terminal">$ tmux attach -t mini-ff-1</div>
                ${renderTerminalDropOverlay(item.dragActive)}
              </div>
              ${renderTerminalAttachmentTray({
                attachments: item.attachments,
                dragActive: item.dragActive,
                onRetry: (id) => {
                  this.lastAction = `retry ${id}`;
                },
                onRemove: (id) => {
                  this.lastAction = `remove ${id}`;
                },
              })}
            </div>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'terminal-attachment-dev': TerminalAttachmentDev;
  }
}
