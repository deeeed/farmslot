import { html } from 'lit';

import { colors, fonts, layout, spacing } from '../styles/theme-tokens.js';

export function renderAppShellAuthStyles() {
  return html`
    <style>
      farm-app {
        display: flex;
        width: 100vw;
        height: 100vh;
        background: ${colors.bgBase};
        color: ${colors.textPrimary};
        font-family: ${fonts.mono};
        align-items: center;
        justify-content: center;
      }
      farm-app .auth-card {
        width: min(440px, calc(100vw - 48px));
        background: ${colors.bgSurface};
        border: 1px solid ${colors.bgCard};
        border-radius: 12px;
        padding: 24px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
      }
      farm-app .auth-title {
        font-size: ${fonts.sizeXl};
        font-weight: 800;
        margin-bottom: 8px;
      }
      farm-app .auth-copy {
        color: ${colors.textSecondary};
        font-size: ${fonts.sizeSm};
        line-height: 1.5;
        margin-bottom: 18px;
      }
      farm-app .auth-error {
        color: ${colors.statusFail};
        background: ${colors.statusFail}18;
        border: 1px solid ${colors.statusFail}55;
        border-radius: 8px;
        padding: 10px;
        font-size: ${fonts.sizeSm};
        margin-bottom: 16px;
      }
      farm-app .auth-modes {
        display: flex;
        gap: 8px;
        margin-bottom: 14px;
      }
      farm-app .auth-mode {
        flex: 1;
        border: 1px solid ${colors.bgCardHover};
        background: ${colors.bgCard};
        color: ${colors.textSecondary};
        border-radius: 8px;
        padding: 9px 12px;
        font-family: ${fonts.mono};
        font-weight: 700;
        cursor: pointer;
        text-transform: uppercase;
      }
      farm-app .auth-mode.active {
        background: ${colors.accent};
        border-color: ${colors.accent};
        color: white;
      }
      farm-app .auth-input {
        width: 100%;
        box-sizing: border-box;
        background: ${colors.bgInput};
        color: ${colors.textPrimary};
        border: 1px solid ${colors.bgCardHover};
        border-radius: 8px;
        padding: 12px;
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeMd};
        margin-bottom: 14px;
      }
      farm-app .auth-submit {
        width: 100%;
        background: ${colors.accent};
        color: white;
        border: none;
        border-radius: 8px;
        padding: 12px;
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeMd};
        font-weight: 800;
        cursor: pointer;
      }
      farm-app .auth-submit:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    </style>
  `;
}

export function renderAppShellStyles(sidebarExpanded: boolean) {
  return html`
    <style>
      farm-app {
        display: flex;
        width: 100vw;
        height: 100vh;
        overflow: hidden;
        background: ${colors.bgBase};
        color: ${colors.textPrimary};
        font-family: ${fonts.mono};
      }
      farm-app > nav {
        width: ${sidebarExpanded ? layout.sidebarWidthExpanded : layout.sidebarWidth};
        background: ${colors.bgSidebar};
        border-right: 1px solid ${colors.bgCard};
        display: flex;
        flex-direction: column;
        align-items: ${sidebarExpanded ? 'stretch' : 'center'};
        padding-top: ${spacing.md};
        gap: ${spacing.xs};
        flex-shrink: 0;
        transition: width 0.2s ease;
        overflow: hidden;
      }
      farm-app .fa-nav-btn {
        width: ${sidebarExpanded ? 'auto' : '36px'};
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: ${sidebarExpanded ? 'flex-start' : 'center'};
        gap: 8px;
        border: none;
        background: transparent;
        color: ${colors.textMuted};
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeMd};
        font-weight: 700;
        cursor: pointer;
        border-radius: 6px;
        transition:
          background 0.15s,
          color 0.15s;
        position: relative;
        padding: ${sidebarExpanded ? '0 12px' : '0'};
        margin: ${sidebarExpanded ? '0 6px' : '0'};
        white-space: nowrap;
        text-decoration: none;
      }
      farm-app .fa-nav-btn:hover {
        background: ${colors.bgCard};
        color: ${colors.textSecondary};
      }
      farm-app .fa-nav-btn.active {
        background: ${colors.accent}22;
        color: ${colors.accent};
      }
      farm-app .fa-nav-label {
        font-size: ${fonts.sizeSm};
        font-weight: 500;
        overflow: hidden;
      }
      farm-app .fa-nav-toggle {
        width: ${sidebarExpanded ? 'auto' : '36px'};
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: ${sidebarExpanded ? 'flex-start' : 'center'};
        border: none;
        background: transparent;
        color: ${colors.textMuted};
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeMd};
        cursor: pointer;
        border-radius: 6px;
        padding: ${sidebarExpanded ? '0 12px' : '0'};
        margin: ${sidebarExpanded ? '0 6px' : '0'};
        margin-bottom: ${spacing.sm};
      }
      farm-app .fa-nav-toggle:hover {
        background: ${colors.bgCard};
        color: ${colors.textSecondary};
      }
      farm-app .fa-badge-count {
        position: absolute;
        top: 2px;
        right: 2px;
        min-width: 14px;
        height: 14px;
        background: ${colors.statusFail};
        color: #fff;
        font-size: 9px;
        font-weight: 600;
        border-radius: 7px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 3px;
      }
      farm-app .fa-main {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-width: 0;
      }
      farm-app .fa-content {
        flex: 1;
        overflow: hidden;
      }
      farm-app .pairing-overlay {
        position: fixed;
        inset: 0;
        z-index: 50;
        background: rgba(0, 0, 0, 0.68);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      farm-app .pairing-card {
        width: min(460px, calc(100vw - 48px));
        background: ${colors.bgSurface};
        border: 1px solid ${colors.bgCardHover};
        border-radius: 14px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
        padding: 22px;
      }
      farm-app .pairing-header {
        display: flex;
        gap: 16px;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 18px;
      }
      farm-app .pairing-title {
        color: ${colors.textPrimary};
        font-size: ${fonts.sizeXl};
        font-weight: 800;
        margin-bottom: 6px;
      }
      farm-app .pairing-copy,
      farm-app .pairing-empty,
      farm-app .pairing-expiry {
        color: ${colors.textSecondary};
        font-size: ${fonts.sizeSm};
        line-height: 1.45;
      }
      farm-app .pairing-close {
        width: 30px;
        height: 30px;
        border: 1px solid ${colors.bgCardHover};
        border-radius: 8px;
        background: ${colors.bgCard};
        color: ${colors.textSecondary};
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
      }
      farm-app .pairing-label {
        display: block;
        color: ${colors.textSecondary};
        font-size: ${fonts.sizeXs};
        font-weight: 800;
        text-transform: uppercase;
        margin: 12px 0 6px;
      }
      farm-app .pairing-input {
        width: 100%;
        box-sizing: border-box;
        background: ${colors.bgInput};
        color: ${colors.textPrimary};
        border: 1px solid ${colors.bgCardHover};
        border-radius: 8px;
        padding: 11px 12px;
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeSm};
      }
      farm-app .pairing-submit {
        width: 100%;
        margin-top: 16px;
        background: ${colors.accent};
        color: white;
        border: none;
        border-radius: 8px;
        padding: 12px;
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeMd};
        font-weight: 800;
        cursor: pointer;
      }
      farm-app .pairing-submit:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      farm-app .pairing-error {
        background: ${colors.statusFail}18;
        border: 1px solid ${colors.statusFail}55;
        border-radius: 8px;
        color: ${colors.statusFail};
        font-size: ${fonts.sizeSm};
        padding: 10px;
        margin-bottom: 12px;
      }
      farm-app .pairing-status-grid {
        display: grid;
        gap: 8px;
        margin-bottom: 16px;
      }
      farm-app .pairing-status-grid div {
        background: ${colors.bgCard};
        border: 1px solid ${colors.bgCardHover};
        border-radius: 8px;
        padding: 9px 10px;
      }
      farm-app .pairing-status-grid span {
        display: block;
        color: ${colors.textMuted};
        font-size: ${fonts.sizeXs};
        font-weight: 800;
        margin-bottom: 4px;
        text-transform: uppercase;
      }
      farm-app .pairing-status-grid strong {
        display: block;
        color: ${colors.textPrimary};
        font-size: ${fonts.sizeSm};
        font-weight: 700;
        overflow-wrap: anywhere;
      }
      farm-app .pairing-qr-wrap {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        margin-top: 18px;
      }
      farm-app .pairing-qr {
        width: 260px;
        height: 260px;
        image-rendering: pixelated;
        background: white;
        border-radius: 10px;
        padding: 10px;
      }
      farm-app .pairing-empty {
        margin-top: 16px;
        border: 1px dashed ${colors.bgCardHover};
        border-radius: 10px;
        padding: 16px;
        text-align: center;
      }
    </style>
  `;
}
