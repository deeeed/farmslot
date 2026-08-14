import { html } from 'lit';

import { colors, fonts, radii, shadows, spacing } from '../../styles/theme-tokens.js';

export function renderChatPanelStyles() {
  return html`<style>
    @keyframes blink {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0;
      }
    }
    chat-panel .cp-drawer {
      position: fixed;
      bottom: var(--farmslot-recipe-hud-height, 0px);
      left: 0;
      right: 0;
      height: var(--cp-height);
      background: ${colors.bgSurface};
      border-top: 1px solid ${colors.bgCard};
      box-shadow: ${shadows.elevated};
      z-index: 1000;
      display: flex;
      flex-direction: column;
      font-family: ${fonts.mono};
    }
    chat-panel .cp-drawer.fullscreen {
      top: 0;
      height: calc(100vh - var(--farmslot-recipe-hud-height, 0px));
    }
    chat-panel .cp-resize-handle {
      position: absolute;
      top: -4px;
      left: 0;
      right: 0;
      height: 8px;
      cursor: ns-resize;
      touch-action: none;
    }
    chat-panel .cp-resize-handle::after {
      content: '';
      position: absolute;
      top: 3px;
      left: 50%;
      width: 72px;
      height: 2px;
      transform: translateX(-50%);
      border-radius: 2px;
      background: ${colors.textMuted}55;
    }
    chat-panel .cp-drawer.fullscreen .cp-resize-handle {
      display: none;
    }
    chat-panel .cp-header {
      display: flex;
      align-items: center;
      padding: ${spacing.md} ${spacing.xl};
      border-bottom: 1px solid ${colors.bgCard};
      gap: ${spacing.md};
      flex-shrink: 0;
    }
    chat-panel .cp-title {
      color: ${colors.textAccent};
      font-weight: 700;
      font-size: ${fonts.sizeMd};
      flex: 1;
    }
    chat-panel .cp-session {
      display: flex;
      align-items: center;
      gap: ${spacing.sm};
      color: ${colors.textMuted};
      font-size: ${fonts.sizeXs};
      min-width: 0;
    }
    chat-panel .cp-session-kicker {
      color: ${colors.textMuted};
      font-size: 10px;
      text-transform: uppercase;
    }
    chat-panel .cp-session-label {
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    chat-panel .cp-session-select {
      background: ${colors.bgInput};
      color: ${colors.textSecondary};
      border: 1px solid ${colors.textMuted}44;
      border-radius: ${radii.sm};
      font-family: ${fonts.mono};
      font-size: ${fonts.sizeXs};
      padding: 2px 6px;
      max-width: 150px;
    }
    chat-panel .cp-observer {
      position: relative;
      color: ${colors.textMuted};
      font-size: ${fonts.sizeXs};
    }
    chat-panel .cp-observer summary {
      list-style: none;
      cursor: pointer;
      border: 1px solid ${colors.statusWarn}55;
      border-radius: ${radii.sm};
      color: ${colors.statusWarn};
      padding: 2px 8px;
      user-select: none;
    }
    chat-panel .cp-observer summary::-webkit-details-marker {
      display: none;
    }
    chat-panel .cp-observer-list {
      position: absolute;
      right: 0;
      top: calc(100% + ${spacing.sm});
      width: min(420px, 80vw);
      max-height: 220px;
      overflow: auto;
      background: ${colors.bgSurface};
      border: 1px solid ${colors.bgCard};
      border-radius: ${radii.sm};
      box-shadow: ${shadows.elevated};
      z-index: 2;
      padding: ${spacing.sm};
    }
    chat-panel .cp-observer-item {
      padding: ${spacing.sm};
      border-bottom: 1px solid ${colors.bgCard};
      overflow-wrap: anywhere;
    }
    chat-panel .cp-observer-item:last-child {
      border-bottom: none;
    }
    chat-panel .cp-observer-meta {
      display: block;
      color: ${colors.textMuted};
      font-size: 10px;
      margin-bottom: 2px;
    }
    chat-panel .cp-new-btn {
      background: transparent;
      color: ${colors.textMuted};
      border: 1px solid ${colors.textMuted}44;
      border-radius: ${radii.sm};
      padding: 2px 8px;
      font-family: ${fonts.mono};
      font-size: ${fonts.sizeSm};
      cursor: pointer;
    }
    chat-panel .cp-new-btn:hover {
      color: ${colors.textSecondary};
    }
    chat-panel .cp-icon-btn {
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: ${colors.bgCard};
      color: ${colors.textMuted};
      border: 1px solid ${colors.textMuted}33;
      border-radius: ${radii.sm};
      font-family: ${fonts.mono};
      font-size: ${fonts.sizeMd};
      line-height: 1;
      cursor: pointer;
      flex-shrink: 0;
    }
    chat-panel .cp-icon-btn:hover {
      color: ${colors.textSecondary};
    }
    chat-panel .cp-close-btn {
      background: transparent;
      border: none;
      color: ${colors.textMuted};
      cursor: pointer;
      font-size: ${fonts.sizeLg};
      line-height: 1;
      padding: 2px 4px;
    }
    chat-panel .cp-close-btn:hover {
      color: ${colors.textPrimary};
    }
    chat-panel .cp-messages {
      flex: 1;
      overflow-y: auto;
      padding: ${spacing.xl};
      display: flex;
      flex-direction: column;
    }
    chat-panel .cp-terminal {
      flex: 1;
      min-height: 200px;
      padding: ${spacing.sm};
      overflow: hidden;
    }
    chat-panel .cp-runtime-head .cp-runtime-pressure {
      flex: 1;
    }
    chat-panel .cp-runtime.compact .cp-runtime-grid,
    chat-panel .cp-runtime.compact .cp-runtime-warning,
    chat-panel .cp-runtime.compact .cp-runtime-reason,
    chat-panel .cp-runtime.compact .cp-runtime-config,
    chat-panel .cp-runtime.compact .cp-runtime-actions,
    chat-panel .cp-runtime.compact .cp-dangerous {
      display: none;
    }
    chat-panel .cp-terminal terminal-view {
      height: 100%;
      min-height: 0;
    }
    chat-panel .cp-terminal-loading {
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: ${spacing.md};
      align-items: center;
      justify-content: center;
      color: ${colors.textMuted};
      font-size: ${fonts.sizeSm};
    }
    chat-panel .cp-streaming {
      background: ${colors.bgCard};
      border: 1px solid ${colors.bgCardHover};
      border-radius: ${radii.md};
      padding: ${spacing.md} ${spacing.lg};
      font-size: ${fonts.sizeSm};
      color: ${colors.textSecondary};
      max-width: 85%;
      word-break: break-word;
      margin-bottom: ${spacing.lg};
    }
    chat-panel .cp-streaming-status {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      max-width: 100%;
      margin-bottom: ${spacing.sm};
      padding: 2px 8px;
      border: 1px solid ${colors.textMuted}33;
      border-radius: ${radii.sm};
      color: ${colors.textMuted};
      font-size: 10px;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    chat-panel .cp-streaming-status.error {
      color: ${colors.statusFail};
      border-color: ${colors.statusFail}66;
    }
    chat-panel .cp-streaming-body {
      white-space: pre-wrap;
    }
    chat-panel .cp-streaming-body.error {
      color: ${colors.statusFail};
    }
    chat-panel .cp-empty {
      color: ${colors.textMuted};
      font-size: ${fonts.sizeSm};
      text-align: center;
      margin-top: ${spacing.xxl};
    }
    chat-panel .cp-toast {
      position: absolute;
      top: 48px;
      right: ${spacing.xl};
      background: ${colors.bgCard};
      border: 1px solid ${colors.statusOk}44;
      color: ${colors.statusOk};
      border-radius: ${radii.sm};
      padding: ${spacing.sm} ${spacing.lg};
      font-size: ${fonts.sizeXs};
      z-index: 10;
    }
    chat-panel .cp-stop-btn {
      background: transparent;
      color: ${colors.statusFail};
      border: 1px solid ${colors.statusFail}44;
      border-radius: ${radii.sm};
      padding: 2px 8px;
      font-family: ${fonts.mono};
      font-size: ${fonts.sizeSm};
      cursor: pointer;
    }
    chat-panel .cp-stop-btn:hover {
      background: ${colors.statusFail}22;
    }
    chat-panel .cp-runtime {
      padding: ${spacing.sm} ${spacing.xl};
      border-bottom: 1px solid ${colors.bgCard};
      background: ${colors.bgBase};
      color: ${colors.textMuted};
      font-size: ${fonts.sizeXs};
      flex-shrink: 0;
    }
    chat-panel .cp-runtime-head,
    chat-panel .cp-runtime-actions {
      display: flex;
      align-items: center;
      gap: ${spacing.sm};
      flex-wrap: wrap;
    }
    chat-panel .cp-runtime-status,
    chat-panel .cp-runtime-pressure {
      border: 1px solid ${colors.textMuted}44;
      border-radius: ${radii.sm};
      padding: 2px 7px;
      text-transform: uppercase;
      font-size: 10px;
    }
    chat-panel .cp-runtime-status.running {
      color: ${colors.statusOk};
      border-color: ${colors.statusOk}66;
    }
    chat-panel .cp-runtime-status.failed,
    chat-panel .cp-runtime-status.ambiguous,
    chat-panel .cp-runtime-pressure.high {
      color: ${colors.statusFail};
      border-color: ${colors.statusFail}66;
    }
    chat-panel .cp-runtime-grid {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr);
      gap: 2px ${spacing.sm};
      margin: ${spacing.sm} 0;
    }
    chat-panel .cp-runtime-grid strong {
      color: ${colors.textSecondary};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    chat-panel .cp-runtime-config {
      display: grid;
      gap: ${spacing.sm};
      margin: ${spacing.md} 0;
      padding: ${spacing.md};
      border: 1px solid ${colors.bgCardHover};
      border-radius: ${radii.sm};
    }
    chat-panel .cp-runtime-autostart {
      display: flex;
      align-items: center;
      gap: ${spacing.sm};
      color: ${colors.textSecondary};
    }
    chat-panel .cp-runtime-warning,
    chat-panel .cp-runtime-error,
    chat-panel .cp-runtime-reason {
      margin: ${spacing.sm} 0;
    }
    chat-panel .cp-runtime-warning {
      color: ${colors.statusWarn};
    }
    chat-panel .cp-runtime-error {
      color: ${colors.statusFail};
    }
    chat-panel .cp-dangerous {
      margin-top: ${spacing.sm};
      padding: ${spacing.md};
      border: 1px solid ${colors.statusFail}66;
      border-radius: ${radii.sm};
      color: ${colors.textSecondary};
    }
    chat-panel .cp-dangerous p {
      margin: ${spacing.sm} 0;
    }
    chat-panel .cp-dangerous label,
    chat-panel .cp-dangerous input {
      display: block;
      width: 100%;
    }
    chat-panel .cp-dangerous input {
      box-sizing: border-box;
      margin: ${spacing.sm} 0;
      padding: ${spacing.sm};
      background: ${colors.bgInput};
      color: ${colors.textPrimary};
      border: 1px solid ${colors.statusFail}66;
      border-radius: ${radii.sm};
      font-family: ${fonts.mono};
    }
    chat-panel .cp-usage-panel {
      max-height: 220px;
      overflow: auto;
      border-bottom: 1px solid ${colors.bgCard};
      background: ${colors.bgBase};
      flex-shrink: 0;
    }
    chat-panel .cp-usage-head {
      display: flex;
      align-items: center;
      gap: ${spacing.md};
      padding: ${spacing.sm} ${spacing.xl};
      border-bottom: 1px solid ${colors.bgCard};
      color: ${colors.textMuted};
      font-size: ${fonts.sizeXs};
    }
    chat-panel .cp-usage-meta {
      flex: 1;
    }
    chat-panel .cp-usage-grid {
      padding: ${spacing.md} ${spacing.xl};
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: ${spacing.md};
    }
    chat-panel .cp-usage-card {
      border: 1px solid ${colors.bgCard};
      border-radius: ${radii.sm};
      padding: ${spacing.sm} ${spacing.md};
      min-width: 0;
    }
    chat-panel .cp-usage-label {
      color: ${colors.textMuted};
      font-size: 10px;
      margin-bottom: 3px;
    }
    chat-panel .cp-usage-value {
      color: ${colors.textPrimary};
      font-size: ${fonts.sizeSm};
      overflow-wrap: anywhere;
    }
    chat-panel .cp-usage-note {
      color: ${colors.textMuted};
      font-size: ${fonts.sizeXs};
      padding: 0 ${spacing.xl} ${spacing.md};
      line-height: 1.45;
    }
    chat-panel .cp-usage-error {
      color: ${colors.statusFail};
      padding: ${spacing.md} ${spacing.xl};
      font-size: 11px;
    }
    @media (max-width: 720px) {
      chat-panel .cp-usage-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    chat-panel .cp-cost-warning {
      background: ${colors.statusWarn}15;
      border: 1px solid ${colors.statusWarn}44;
      color: ${colors.statusWarn};
      font-size: ${fonts.sizeXs};
      padding: ${spacing.sm} ${spacing.lg};
      text-align: center;
    }
  </style>`;
}
