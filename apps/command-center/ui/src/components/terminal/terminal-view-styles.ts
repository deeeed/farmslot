import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, runnerColor, spacing } from '../../styles/theme-tokens.js';

export function syncTerminalRunnerAccent(host: HTMLElement, runner: string) {
  const accent = runnerColor(runner);
  if (accent) {
    host.style.setProperty('--runner-accent', accent);
    host.setAttribute('data-has-runner', '');
  } else {
    host.style.removeProperty('--runner-accent');
    host.removeAttribute('data-has-runner');
  }
}

export const terminalViewStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid var(--runner-accent, #1e1e36);
    border-radius: ${unsafeCSS(radii.md)};
    overflow: hidden;
    min-height: 200px;
  }

  :host([data-has-runner]) {
    border-left-width: 3px;
  }

  .header {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.md)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    background: ${unsafeCSS(colors.bgCard)};
    border-bottom: 1px solid #1e1e36;
    cursor: pointer;
    user-select: none;
    flex-shrink: 0;
  }

  .header:hover {
    background: ${unsafeCSS(colors.bgCardHover)};
  }

  .slot-id {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
  }

  .badge {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    padding: 1px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .badge.ready {
    background: ${unsafeCSS(colors.lifecycleReady)}22;
    color: ${unsafeCSS(colors.lifecycleReady)};
  }
  .badge.busy {
    background: ${unsafeCSS(colors.lifecycleBusy)}22;
    color: ${unsafeCSS(colors.lifecycleBusy)};
  }
  .badge.held {
    background: ${unsafeCSS(colors.lifecycleHeld)}22;
    color: ${unsafeCSS(colors.lifecycleHeld)};
  }
  .badge.manual {
    background: ${unsafeCSS(colors.lifecycleManual)}22;
    color: ${unsafeCSS(colors.lifecycleManual)};
  }
  .badge.disabled {
    background: ${unsafeCSS(colors.lifecycleDisabled)}22;
    color: ${unsafeCSS(colors.lifecycleDisabled)};
  }

  .badge.mode-pty {
    background: ${unsafeCSS(colors.statusOk)}22;
    color: ${unsafeCSS(colors.statusOk)};
  }

  .badge.mode-poll {
    background: #66666622;
    color: #999;
  }

  .runner-badge {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    padding: 1px 6px;
    border-radius: 3px;
    background: transparent;
    color: var(--runner-accent, ${unsafeCSS(colors.textSecondary)});
    border: 1px solid var(--runner-accent, #2a2a44);
    text-transform: lowercase;
    letter-spacing: 0.3px;
    cursor: help;
  }

  .runner-badge.dim {
    opacity: 0.55;
  }

  .runner-badge .runner-model {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }

  .agent-state {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textMuted)};
  }

  .task-summary {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textSecondary)};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
  }

  .slot-link {
    background: transparent;
    border: none;
    font-size: 12px;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    font-family: ${unsafeCSS(fonts.mono)};
    text-decoration: none;
    padding: 2px 4px;
    border-radius: 3px;
  }

  .slot-link:hover {
    color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}18;
  }

  .slot-link.close:hover {
    color: ${unsafeCSS(colors.statusFail)};
    background: ${unsafeCSS(colors.statusFail)}18;
  }

  .progress-strip {
    padding: 2px ${unsafeCSS(spacing.md)};
    border-bottom: 1px solid #1e1e36;
    background: ${unsafeCSS(colors.bgCard)};
    flex-shrink: 0;
  }

  .tmux-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px ${unsafeCSS(spacing.md)};
    background: ${unsafeCSS(colors.bgCard)};
    border-bottom: 1px solid #1e1e36;
    flex-shrink: 0;
    flex-wrap: wrap;
    min-height: 26px;
  }

  .tmux-group {
    display: flex;
    align-items: center;
    gap: 1px;
  }

  .tmux-sep {
    width: 1px;
    height: 16px;
    background: #2a2a44;
    margin: 0 4px;
    flex-shrink: 0;
  }

  .tmux-btn {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    padding: 2px 6px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.1s;
  }

  .tmux-btn:hover {
    background: rgba(99, 102, 241, 0.12);
    color: ${unsafeCSS(colors.textPrimary)};
    border-color: #2a2a44;
  }

  .tmux-btn.active {
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)}44;
  }

  .tmux-btn.danger:hover {
    background: rgba(255, 68, 68, 0.12);
    color: ${unsafeCSS(colors.statusFail)};
  }

  .tmux-btn.warn {
    color: ${unsafeCSS(colors.statusWarn)};
  }

  .tmux-btn.warn:hover {
    background: rgba(255, 204, 0, 0.12);
  }

  .tmux-label {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 9px;
    color: ${unsafeCSS(colors.textMuted)};
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-right: 2px;
  }

  .tmux-windows {
    display: flex;
    gap: 1px;
    margin-left: auto;
  }

  .tmux-win-btn {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    padding: 2px 6px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    transition: all 0.1s;
  }

  .tmux-win-btn:hover {
    background: rgba(99, 102, 241, 0.12);
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .tmux-win-btn.active {
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)}44;
  }

  .tmux-rename-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    margin-top: 2px;
  }

  .tmux-rename-input {
    flex: 1;
    max-width: 200px;
    padding: 2px 6px;
    border: 1px solid ${unsafeCSS(colors.accent)}44;
    border-radius: 3px;
    background: ${unsafeCSS(colors.bgInput)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    outline: none;
  }

  .tmux-rename-input:focus {
    border-color: ${unsafeCSS(colors.accent)};
  }

  .terminal-container {
    height: 100%;
    padding: ${unsafeCSS(spacing.sm)};
    min-height: 0;
  }

  .input-bar {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    border-top: 1px solid #1e1e36;
    background: ${unsafeCSS(colors.bgCard)};
    flex-shrink: 0;
  }

  .input-field {
    flex: 1;
    background: ${unsafeCSS(colors.bgInput)};
    border: 1px solid #2a2a44;
    border-radius: ${unsafeCSS(radii.sm)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    outline: none;
  }

  .input-field:focus {
    border-color: ${unsafeCSS(colors.accent)};
  }

  .send-btn {
    background: ${unsafeCSS(colors.accent)};
    color: #fff;
    border: none;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .send-btn:hover {
    background: ${unsafeCSS(colors.accentHover)};
  }

  .exit-bar {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.md)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    border-top: 1px solid ${unsafeCSS(colors.statusWarn)}44;
    background: ${unsafeCSS(colors.statusWarn)}0a;
    flex-shrink: 0;
  }

  .exit-msg {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.statusWarn)};
  }

  .reconnect-btn {
    background: ${unsafeCSS(colors.statusWarn)}22;
    color: ${unsafeCSS(colors.statusWarn)};
    border: 1px solid ${unsafeCSS(colors.statusWarn)}44;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    cursor: pointer;
    margin-left: auto;
  }

  .reconnect-btn:hover {
    background: ${unsafeCSS(colors.statusWarn)}33;
  }

  .reconnect-btn:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  .loading-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: ${unsafeCSS(colors.bgSurface)}cc;
    z-index: 10;
  }

  .spinner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${unsafeCSS(spacing.md)};
  }

  .spinner-dots {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeLg)};
    color: ${unsafeCSS(colors.accent)};
    animation: pulse 1.2s ease-in-out infinite;
  }

  .spinner-text {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textSecondary)};
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }

  .terminal-wrap {
    flex: 1;
    position: relative;
    min-height: 0;
  }

  .copy-toast {
    position: absolute;
    top: 8px;
    right: 12px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.statusOk)};
    background: ${unsafeCSS(colors.bgCard)}cc;
    padding: 2px 8px;
    border-radius: 3px;
    pointer-events: none;
    z-index: 20;
    animation: toast-fade 1.5s ease-out forwards;
  }

  @keyframes toast-fade {
    0%,
    60% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }

  /* Essential xterm styles for shadow DOM */
  .xterm {
    cursor: text;
    position: relative;
    user-select: none;
  }
  .xterm.focus,
  .xterm:focus {
    outline: none;
  }
  .xterm .xterm-helpers {
    position: absolute;
    top: 0;
    z-index: 5;
  }
  .xterm .xterm-helper-textarea {
    padding: 0;
    border: 0;
    margin: 0;
    position: absolute;
    opacity: 0;
    left: -9999em;
    top: 0;
    width: 0;
    height: 0;
    z-index: -5;
    white-space: nowrap;
    overflow: hidden;
    resize: none;
  }
  .xterm .xterm-screen {
    position: relative;
  }
  .xterm .xterm-screen canvas {
    position: absolute;
    left: 0;
    top: 0;
  }
  .xterm .xterm-viewport {
    background-color: transparent;
    overflow-y: scroll;
    cursor: default;
    position: absolute;
    right: 0;
    left: 0;
    top: 0;
    bottom: 0;
  }
  .xterm .xterm-viewport::-webkit-scrollbar {
    width: 6px;
  }
  .xterm .xterm-viewport::-webkit-scrollbar-thumb {
    background: ${unsafeCSS(colors.textMuted)};
    border-radius: 3px;
  }
`;
