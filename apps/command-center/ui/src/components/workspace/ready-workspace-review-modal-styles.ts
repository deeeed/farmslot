import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export function readyWorkspaceReviewModalStyles(): string {
  return `
      ready-workspace .rdy-review-modal {
        width: min(920px, calc(100vw - 48px));
        background: ${colors.bgBase};
        border: 1px solid #2a2a44;
        border-radius: ${radii.lg};
        box-shadow: 0 24px 80px rgba(0,0,0,0.5);
        padding: ${spacing.lg};
        display: grid;
        gap: ${spacing.md};
      }
      ready-workspace .rdy-review-flow {
        border-top: 1px solid #2a2a44;
        padding: ${spacing.lg} 0;
        display: grid;
        gap: ${spacing.md};
      }
      ready-workspace .rdy-review-flow-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: ${spacing.md};
        flex-wrap: wrap;
      }
      ready-workspace .rdy-review-flow h3 {
        margin: 0;
        font-size: 15px;
      }
      ready-workspace .rdy-review-flow p {
        margin: 6px 0 0;
        color: ${colors.textMuted};
        font-size: 11px;
        line-height: 1.5;
      }
      ready-workspace .rdy-review-flow-summary {
        display: flex;
        gap: ${spacing.sm};
        flex-wrap: wrap;
      }
      ready-workspace .rdy-review-flow-summary span {
        border: 1px solid #2a2a44;
        border-radius: ${radii.sm};
        background: ${colors.bgSurface};
        color: ${colors.textSecondary};
        padding: 6px 10px;
        font-size: 11px;
      }
      ready-workspace .rdy-review-flow-summary span.attention {
        border-color: ${colors.statusWarn}88;
        color: ${colors.statusWarn};
      }
      ready-workspace .rdy-review-flow-view-picker {
        display: flex;
        gap: 6px;
      }
      ready-workspace .rdy-review-flow-view-picker button {
        border: 1px solid #2a2a44;
        border-radius: ${radii.sm};
        background: ${colors.bgSurface};
        color: ${colors.textSecondary};
        cursor: pointer;
        font-family: ${fonts.mono};
        font-size: 11px;
        padding: 6px 10px;
      }
      ready-workspace .rdy-review-flow-view-picker button.active {
        border-color: ${colors.accent};
        background: ${colors.accent}18;
        color: ${colors.textPrimary};
      }
      ready-workspace .rdy-review-flow-layout {
        display: grid;
        grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
        gap: ${spacing.md};
        min-height: 0;
      }
      ready-workspace .rdy-review-flow-layout.chronological {
        grid-template-columns: minmax(0, 1fr);
      }
      ready-workspace .rdy-review-flow-nav {
        display: flex;
        flex-direction: column;
        gap: 6px;
        overflow: auto;
        padding-right: 4px;
      }
      ready-workspace .rdy-review-flow-nav button {
        display: grid;
        gap: 3px;
        text-align: left;
        border: 1px solid #2a2a44;
        border-radius: ${radii.md};
        background: ${colors.bgSurface};
        color: ${colors.textPrimary};
        font-family: ${fonts.mono};
        padding: 9px 10px;
        cursor: pointer;
      }
      ready-workspace .rdy-review-flow-nav button:hover,
      ready-workspace .rdy-review-flow-nav button.active {
        border-color: ${colors.accent};
        background: ${colors.accent}12;
      }
      ready-workspace .rdy-review-flow-nav button strong::before {
        content: '';
        display: inline-block;
        width: 8px;
        height: 8px;
        margin-right: 6px;
        border-radius: 50%;
        background: var(--runner, ${colors.accent});
      }
      ready-workspace .rdy-review-flow-nav button span {
        color: ${colors.textMuted};
        font-size: 10px;
      }
      ready-workspace .rdy-review-flow-detail {
        overflow: auto;
        min-width: 0;
        border: 1px solid #2a2a44;
        border-radius: ${radii.md};
        background: ${colors.bgSurface};
        padding: ${spacing.md};
      }
      ready-workspace .rdy-review-flow-fix-summary {
        margin-top: ${spacing.md};
        border-top: 1px solid #2a2a44;
        padding-top: ${spacing.md};
      }
      @media (max-width: 800px) {
        ready-workspace .rdy-review-flow-layout {
          grid-template-columns: 1fr;
        }
        ready-workspace .rdy-review-flow-nav {
          max-height: 180px;
        }
      }
      ready-workspace .rdy-review-modal-head {
        display: flex;
        justify-content: space-between;
        gap: ${spacing.md};
        align-items: flex-start;
      }
      ready-workspace .rdy-review-modal-eyebrow {
        color: ${colors.accent};
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-weight: 700;
      }
      ready-workspace .rdy-review-modal h3 {
        margin: 3px 0 0;
        font-size: 16px;
      }
      ready-workspace .rdy-review-modal p {
        margin: 6px 0 0;
        color: ${colors.textMuted};
        font-size: 11px;
        line-height: 1.5;
      }
      ready-workspace .rdy-modal-close {
        background: transparent;
        color: ${colors.textMuted};
        border: 1px solid #2a2a44;
        border-radius: ${radii.sm};
        padding: 4px 9px;
        cursor: pointer;
        font-family: ${fonts.mono};
      }
      ready-workspace .rdy-modal-close:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      ready-workspace .rdy-review-modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: ${spacing.sm};
      }
      ready-workspace .rdy-resolved-badge {
        padding: 4px 10px; border-radius: ${radii.sm}; font-size: ${fonts.sizeXs};
        background: ${colors.textMuted}22; color: ${colors.textMuted};
        font-family: ${fonts.mono}; text-transform: uppercase; letter-spacing: 0.04em;
      }
      ready-workspace .rdy-resolved-banner {
        padding: 6px 12px; font-family: ${fonts.mono}; font-size: ${fonts.sizeXs};
        color: ${colors.statusWarn}; background: ${colors.statusWarn}15;
        border-bottom: 1px solid ${colors.statusWarn}44;
        line-height: 1.5;
      }
      @keyframes rdy-pulse { 0% { opacity: 1; } 100% { opacity: 0.7; } }
      ready-workspace .rdy-confirming {
        background: ${colors.statusWarn}22; border: 1px solid ${colors.statusWarn};
        color: ${colors.statusWarn}; animation: rdy-pulse 0.6s ease-in-out infinite alternate;
      }

      ready-workspace .rdy-split {
        display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden;
        position: relative;
      }
      ready-workspace .rdy-package-panel {
        border-bottom: 1px solid #2a2a44;
        background: ${colors.bgSurface};
        padding: ${spacing.md} ${spacing.lg};
        display: flex;
        flex-direction: column;
        gap: ${spacing.sm};
        flex-shrink: 0;
        max-height: min(42vh, 440px);
        min-height: 0;
        overflow: hidden;
      }
  `;
}
