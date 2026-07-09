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

export function renderAppShellStyles(
  sidebarExpanded: boolean,
  sidebarWidth: number,
  sidebarResizing = false,
) {
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
        width: ${sidebarExpanded ? `${sidebarWidth}px` : layout.sidebarWidth};
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
        position: relative;
        user-select: ${sidebarResizing ? 'none' : 'auto'};
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
      farm-app .fa-nav-icon {
        width: 20px;
        height: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        border: 1px solid transparent;
        border-radius: 6px;
        box-sizing: border-box;
      }
      farm-app .fa-nav-btn--alpha .fa-nav-icon {
        border-color: ${colors.statusWarn}44;
      }
      farm-app .fa-nav-btn--alpha.active .fa-nav-icon {
        border: 1px solid ${colors.statusWarn}77;
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
      farm-app .fa-alpha-badge {
        margin-left: auto;
        border: 1px solid ${colors.statusWarn}66;
        border-radius: 999px;
        color: ${colors.statusWarn};
        background: ${colors.statusWarn}14;
        font-size: 8px;
        font-weight: 900;
        line-height: 1;
        padding: 3px 5px;
        letter-spacing: 0.04em;
      }
      farm-app .fa-sidebar-resize {
        display: ${sidebarExpanded ? 'block' : 'none'};
        position: absolute;
        top: 0;
        right: -3px;
        width: 6px;
        height: 100%;
        cursor: ew-resize;
        z-index: 3;
      }
      farm-app .fa-sidebar-resize:hover {
        background: ${colors.accent}33;
      }
      farm-app .fa-version-footer {
        margin: 0 6px 4px;
        padding: 0 8px 4px;
        border: 0;
        background: transparent;
        color: ${colors.textMuted};
        font-family: ${fonts.mono};
        font-size: 10px;
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
        cursor: pointer;
      }
      farm-app .fa-version-footer:hover {
        color: ${colors.accent};
      }
      farm-app .fa-version-footer--compact {
        padding: 0 4px 4px;
        text-align: center;
      }
      farm-app .fa-active-runs {
        margin: 2px 6px 8px;
        padding: 6px;
        border: 1px solid ${colors.bgCardHover};
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.12);
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: min(52vh, 520px);
        overflow-y: auto;
      }
      farm-app .fa-active-runs-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        color: ${colors.textMuted};
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        padding: 0 2px;
      }
      farm-app .fa-active-runs-empty,
      farm-app .fa-active-runs-more {
        color: ${colors.textMuted};
        font-size: 11px;
        padding: 6px 2px 2px;
      }
      farm-app .fa-active-runs-more {
        color: ${colors.accent};
        text-decoration: none;
      }
      farm-app .fa-active-runs-more:hover {
        text-decoration: underline;
      }
      farm-app .fa-active-run-wrap {
        position: relative;
      }
      farm-app .fa-active-run {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 7px;
        border-radius: 7px;
        border: 1px solid transparent;
        background: ${colors.bgCard};
        color: ${colors.textSecondary};
        text-decoration: none;
        min-width: 0;
      }
      farm-app .fa-active-run:hover {
        background: ${colors.bgCardHover};
        border-color: ${colors.accent}44;
      }
      farm-app .fa-active-run-unpin {
        position: absolute;
        top: 5px;
        right: 5px;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        border: 1px solid ${colors.bgCardHover};
        background: ${colors.bgSurface};
        color: ${colors.textMuted};
        font-size: 12px;
        line-height: 16px;
        cursor: pointer;
        opacity: 0;
      }
      farm-app .fa-active-run-wrap:hover .fa-active-run-unpin,
      farm-app .fa-active-run-unpin:focus {
        opacity: 1;
      }
      farm-app .fa-active-run-unpin:hover {
        color: ${colors.statusFail};
        border-color: ${colors.statusFail}88;
      }
      farm-app .fa-active-run.active {
        background: ${colors.bgBase};
      }
      farm-app .fa-active-run.active,
      farm-app .fa-active-run.active.needs-attention {
        border-color: ${colors.accent};
        box-shadow:
          0 0 0 1px ${colors.accent}55,
          0 0 16px ${colors.accent}55,
          0 12px 22px rgba(0, 0, 0, 0.35);
      }
      farm-app .fa-active-run.needs-attention {
        border-color: ${colors.statusWarn}aa;
        box-shadow:
          0 0 0 1px ${colors.statusWarn}22,
          0 0 18px ${colors.statusWarn}18;
      }
      farm-app .fa-active-run-top,
      farm-app .fa-active-run-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      farm-app .fa-active-run-ticket {
        color: ${colors.textPrimary};
        font-size: 12px;
        font-weight: 800;
        min-width: 0;
        white-space: normal;
        overflow-wrap: anywhere;
        line-height: 1.25;
      }
      farm-app .fa-active-run-flow {
        flex-shrink: 0;
        border-radius: 4px;
        background: var(--flow-color, ${colors.textMuted});
        color: #000;
        font-size: 9px;
        font-weight: 800;
        padding: 1px 4px;
      }
      farm-app .fa-active-run-summary {
        color: ${colors.textSecondary};
        font-size: 11px;
        line-height: 1.3;
        white-space: normal;
        overflow-wrap: anywhere;
      }
      farm-app .fa-active-run-meta {
        color: ${colors.textMuted};
        font-size: 10px;
        flex-wrap: wrap;
      }
      farm-app .fa-active-run-meta span {
        overflow-wrap: anywhere;
      }
      farm-app .fa-active-run-worker {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--worker-color, ${colors.textMuted});
        font-weight: 700;
      }
      farm-app .fa-active-run-worker-dot {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: var(--worker-color, ${colors.textMuted});
        box-shadow: 0 0 8px var(--worker-color, transparent);
      }
      farm-app .fa-pinned-run-pipeline {
        width: 100%;
        padding-top: 1px;
      }
      farm-app .fa-active-run-steps {
        display: flex;
        gap: 4px;
        padding-top: 1px;
      }
      farm-app .fa-active-run-step {
        height: 4px;
        flex: 1;
        min-width: 10px;
        border-radius: 999px;
        background: var(--step-color, ${colors.textMuted});
        opacity: 0.9;
      }
      farm-app .fa-main {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-width: 0;
      }
      farm-app .fa-main--capture {
        width: 100vw;
      }
      farm-app .fa-content {
        flex: 1;
        overflow: hidden;
      }
      farm-app .fa-content--stacked {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      farm-app .fa-screen-body {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }
      farm-app .fa-route-alpha-banner {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        border-bottom: 1px solid ${colors.statusWarn}33;
        background: ${colors.statusWarn}0f;
        color: ${colors.textSecondary};
        font-size: ${fonts.sizeSm};
        flex-shrink: 0;
      }
      farm-app .fa-route-alpha-banner span {
        border: 1px solid ${colors.statusWarn}77;
        border-radius: 999px;
        color: ${colors.statusWarn};
        background: ${colors.statusWarn}18;
        font-size: 10px;
        font-weight: 900;
        padding: 3px 7px;
        letter-spacing: 0.06em;
      }
      farm-app .fa-route-alpha-banner strong {
        color: ${colors.textPrimary};
      }
      farm-app .fa-route-alpha-banner em {
        color: ${colors.textMuted};
        font-style: normal;
      }
      farm-app .fa-modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 90;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.66);
        padding: 24px;
        box-sizing: border-box;
      }
      farm-app .fa-version-modal {
        width: min(900px, 100%);
        max-height: min(760px, 92vh);
        overflow: auto;
        border: 1px solid ${colors.bgCardHover};
        border-radius: 14px;
        background: ${colors.bgSurface};
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
        padding: 18px;
      }
      farm-app .fa-version-modal-head,
      farm-app .fa-version-actions,
      farm-app .fa-node-version-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      farm-app .fa-version-modal h2,
      farm-app .fa-version-modal h3 {
        margin: 0;
      }
      farm-app .fa-version-kicker {
        color: ${colors.textMuted};
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 4px;
      }
      farm-app .fa-modal-close,
      farm-app .fa-version-actions button,
      farm-app .fa-version-actions a {
        border: 1px solid ${colors.bgCardHover};
        border-radius: 8px;
        background: ${colors.bgCard};
        color: ${colors.textSecondary};
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeSm};
        padding: 8px 10px;
        text-decoration: none;
        cursor: pointer;
      }
      farm-app .fa-version-actions button:hover,
      farm-app .fa-version-actions a:hover,
      farm-app .fa-modal-close:hover {
        color: ${colors.accent};
        border-color: ${colors.accent}88;
      }
      farm-app .fa-version-actions {
        justify-content: flex-start;
        margin: 16px 0;
        flex-wrap: wrap;
      }
      farm-app .fa-version-error {
        border: 1px solid ${colors.statusFail}66;
        border-radius: 8px;
        background: ${colors.statusFail}18;
        color: ${colors.statusFail};
        padding: 10px;
        margin-bottom: 14px;
      }
      farm-app .fa-version-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 12px;
      }
      farm-app .fa-version-card,
      farm-app .fa-version-node-section {
        border: 1px solid ${colors.bgCardHover};
        border-radius: 10px;
        background: ${colors.bgCard};
        padding: 12px;
      }
      farm-app .fa-version-card h3,
      farm-app .fa-version-node-section h3 {
        font-size: ${fonts.sizeMd};
        margin-bottom: 10px;
      }
      farm-app .fa-version-row {
        display: grid;
        grid-template-columns: 92px minmax(0, 1fr);
        gap: 8px;
        padding: 5px 0;
        color: ${colors.textMuted};
        font-size: ${fonts.sizeSm};
      }
      farm-app .fa-version-row strong {
        color: ${colors.textSecondary};
        font-weight: 700;
        overflow-wrap: anywhere;
      }
      farm-app .fa-version-node-section {
        margin-top: 12px;
      }
      farm-app .fa-node-version-row {
        border-top: 1px solid ${colors.bgCardHover};
        padding: 10px 0;
      }
      farm-app .fa-node-version-row:first-of-type {
        border-top: 0;
      }
      farm-app .fa-node-version-row div {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      farm-app .fa-node-version-row span,
      farm-app .fa-version-empty {
        color: ${colors.textMuted};
        font-size: ${fonts.sizeSm};
      }
      farm-app .fa-node-version-pill {
        border: 1px solid ${colors.bgCardHover};
        border-radius: 999px;
        padding: 5px 8px;
        white-space: nowrap;
      }
      farm-app .fa-node-version-pill.ok {
        color: ${colors.statusOk};
        border-color: ${colors.statusOk}66;
      }
      farm-app .fa-node-version-pill.warn {
        color: ${colors.statusWarn};
        border-color: ${colors.statusWarn}66;
      }
      farm-app .onboarding-shell {
        min-height: 100%;
        overflow: auto;
        padding: 32px;
        box-sizing: border-box;
        background:
          radial-gradient(circle at top left, ${colors.accent}24, transparent 34rem),
          ${colors.bgBase};
      }
      farm-app .onboarding-hero {
        max-width: 880px;
        margin-bottom: 24px;
      }
      farm-app .onboarding-kicker {
        color: ${colors.accent};
        font-size: ${fonts.sizeXs};
        font-weight: 900;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        margin-bottom: 10px;
      }
      farm-app .onboarding-hero h1 {
        color: ${colors.textPrimary};
        font-size: 34px;
        line-height: 1.1;
        margin: 0 0 12px;
      }
      farm-app .onboarding-hero p,
      farm-app .onboarding-card p {
        color: ${colors.textSecondary};
        font-size: ${fonts.sizeSm};
        line-height: 1.55;
        margin: 0 0 14px;
      }
      farm-app .onboarding-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 16px;
        max-width: 1040px;
      }
      farm-app .onboarding-card {
        background: ${colors.bgSurface};
        border: 1px solid ${colors.bgCardHover};
        border-radius: 14px;
        padding: 20px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.22);
      }
      farm-app .onboarding-card-wide {
        grid-column: 1 / -1;
      }
      farm-app .onboarding-card h2 {
        color: ${colors.textPrimary};
        font-size: ${fonts.sizeLg};
        margin: 0 0 10px;
      }
      farm-app .onboarding-card pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        background: ${colors.bgInput};
        border: 1px solid ${colors.bgCardHover};
        border-radius: 10px;
        color: ${colors.textPrimary};
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeSm};
        margin: 10px 0 14px;
        padding: 12px;
      }
      farm-app .onboarding-card code {
        color: ${colors.textPrimary};
        font-family: ${fonts.mono};
      }
      farm-app .onboarding-connect {
        display: flex;
        gap: 10px;
        margin-top: 12px;
      }
      farm-app .onboarding-connect input {
        flex: 1;
        min-width: 0;
        box-sizing: border-box;
        background: ${colors.bgInput};
        color: ${colors.textPrimary};
        border: 1px solid ${colors.bgCardHover};
        border-radius: 8px;
        padding: 12px;
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeSm};
      }
      farm-app .onboarding-connect button,
      farm-app .onboarding-actions a {
        border: 1px solid ${colors.accent};
        border-radius: 8px;
        background: ${colors.accent};
        color: white;
        cursor: pointer;
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeSm};
        font-weight: 800;
        padding: 11px 14px;
        text-decoration: none;
      }
      farm-app .onboarding-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 14px;
      }
      farm-app .onboarding-actions a:last-child {
        background: transparent;
        color: ${colors.textSecondary};
        border-color: ${colors.bgCardHover};
      }
      farm-app .onboarding-error {
        color: ${colors.statusFail};
        background: ${colors.statusFail}18;
        border: 1px solid ${colors.statusFail}55;
        border-radius: 8px;
        font-size: ${fonts.sizeSm};
        margin-top: 12px;
        padding: 10px;
      }
      @media (max-width: 720px) {
        farm-app .onboarding-shell {
          padding: 20px;
        }
        farm-app .onboarding-hero h1 {
          font-size: 26px;
        }
        farm-app .onboarding-connect {
          flex-direction: column;
        }
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
      farm-app .pairing-warning {
        background: ${colors.statusWarn}18;
        border: 1px solid ${colors.statusWarn}55;
        border-radius: 8px;
        color: ${colors.statusWarn};
        font-size: ${fonts.sizeSm};
        line-height: 1.45;
        padding: 10px;
        margin-bottom: 12px;
      }
      farm-app .pairing-status-grid {
        display: grid;
        gap: 8px;
        margin-bottom: 16px;
      }
      farm-app .pairing-detected {
        display: grid;
        gap: 6px;
        margin: 12px 0 16px;
      }
      farm-app .pairing-detected > span {
        color: ${colors.textMuted};
        font-size: ${fonts.sizeXs};
        font-weight: 800;
        text-transform: uppercase;
      }
      farm-app .pairing-detected-row {
        background: ${colors.bgCard};
        border: 1px solid ${colors.bgCardHover};
        border-radius: 8px;
        padding: 8px 10px;
      }
      farm-app .pairing-detected-row strong,
      farm-app .pairing-detected-row code {
        display: block;
      }
      farm-app .pairing-detected-row strong {
        color: ${colors.textPrimary};
        font-size: ${fonts.sizeSm};
      }
      farm-app .pairing-detected-row code {
        color: ${colors.textSecondary};
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        overflow-wrap: anywhere;
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
