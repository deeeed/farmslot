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
      ready-workspace .rdy-notice-slot {
        height: 44px; min-height: 44px; box-sizing: border-box; flex-shrink: 0;
        overflow: auto; margin: 0; padding: 6px 12px;
        font-family: ${fonts.mono}; font-size: ${fonts.sizeXs}; line-height: 1.5;
        color: ${colors.textMuted};
      }
      ready-workspace .rdy-resolved-banner {
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
