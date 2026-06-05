import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const mediaLightboxStyles = css`
  :host {
    display: contents;
  }
  .ml-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.78);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: ${unsafeCSS(spacing.lg)};
    z-index: 50;
  }
  .ml-modal {
    width: min(1280px, 96vw);
    max-height: 92vh;
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}33;
    border-radius: ${unsafeCSS(radii.md)};
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .ml-header {
    display: flex;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.md)};
    align-items: center;
    padding: ${unsafeCSS(spacing.md)};
    border-bottom: 1px solid ${unsafeCSS(colors.textMuted)}22;
  }
  .ml-purpose-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 2px;
  }
  .ml-purpose {
    color: ${unsafeCSS(colors.accent)};
    font-size: 10px;
    text-transform: uppercase;
  }
  .ml-file-type {
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    border-radius: 999px;
    padding: 2px 7px;
    color: ${unsafeCSS(colors.textSecondary)};
    background: ${unsafeCSS(colors.bgSurface)};
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.05em;
  }
  .ml-file-type.video {
    border-color: ${unsafeCSS(colors.statusWarn)}77;
    color: ${unsafeCSS(colors.statusWarn)};
    background: ${unsafeCSS(colors.statusWarn)}16;
  }
  .ml-file-type.image {
    border-color: ${unsafeCSS(colors.statusOk)}66;
    color: ${unsafeCSS(colors.statusOk)};
    background: ${unsafeCSS(colors.statusOk)}12;
  }
  .ml-file-type.markdown,
  .ml-file-type.json,
  .ml-file-type.diff {
    border-color: ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}14;
  }
  .ml-path {
    font-size: 11px;
    word-break: break-all;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .ml-caption {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
    margin-top: 4px;
  }
  .ml-provenance {
    font-size: 10px;
    color: ${unsafeCSS(colors.statusOk)};
    margin-top: 2px;
    font-family: ${unsafeCSS(fonts.mono)};
  }
  .ml-provenance-sep {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .ml-scope {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid ${unsafeCSS(colors.accent)}55;
    background: ${unsafeCSS(colors.accent)}14;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 10px;
    width: fit-content;
  }
  .ml-scope-clear {
    border: 0;
    background: transparent;
    color: ${unsafeCSS(colors.accent)};
    font-family: inherit;
    font-size: 10px;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }
  .ml-kind-filter {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .ml-kind-chip {
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    font-family: inherit;
    font-size: 10px;
    cursor: pointer;
  }
  .ml-kind-chip:hover {
    border-color: ${unsafeCSS(colors.textMuted)}88;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .ml-kind-chip.active {
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)}66;
  }
  .ml-count {
    margin-top: 4px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
  }
  .ml-actions {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    align-items: center;
  }
  .ml-btn {
    border: 1px solid ${unsafeCSS(colors.accent)}66;
    background: transparent;
    color: ${unsafeCSS(colors.accent)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 6px 10px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 12px;
    cursor: pointer;
  }
  .ml-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .ml-body {
    padding: ${unsafeCSS(spacing.md)};
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    background: ${unsafeCSS(colors.bgBase)};
  }
  .ml-cmp-body {
    flex-direction: column;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .ml-expanded {
    max-width: 100%;
    max-height: 78vh;
    object-fit: contain;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgBase)};
    transition: transform 0.12s ease-out;
    transform-origin: center center;
    user-select: none;
  }
  .ml-image-shell {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .ml-toolbar {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    justify-content: center;
    align-items: center;
  }
  .ml-stage {
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 240px;
  }
  .ml-video-shell {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.sm)};
    align-items: center;
  }
  .ml-video-shell .ml-video {
    max-height: 68vh;
    background: #000;
  }
  .ml-video-controls {
    width: min(100%, 960px);
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
  }
  .ml-video-control-row,
  .ml-video-scrub-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: ${unsafeCSS(spacing.sm)};
    flex-wrap: wrap;
  }
  .ml-video-scrub {
    min-width: min(560px, 60vw);
    accent-color: ${unsafeCSS(colors.accent)};
  }
  .ml-fallback {
    min-height: 320px;
    width: 100%;
    font-size: 18px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: ${unsafeCSS(colors.textMuted)};
    background: ${unsafeCSS(colors.bgBase)};
  }
  .ml-fallback-meta {
    font-size: 13px;
    font-family: ${unsafeCSS(fonts.mono)};
    word-break: break-all;
    padding: 0 24px;
    text-align: center;
  }
  .ml-broken {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .ml-filmstrip {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    padding: ${unsafeCSS(spacing.md)};
    border-top: 1px solid ${unsafeCSS(colors.textMuted)}22;
    overflow-x: auto;
    background: ${unsafeCSS(colors.bgSurface)};
  }
  .ml-film-item {
    border: 1px solid ${unsafeCSS(colors.textMuted)}33;
    background: transparent;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: center;
    cursor: pointer;
    min-width: 90px;
  }
  .ml-film-item.selected {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}15;
  }
  .ml-film-thumb {
    width: 80px;
    height: 56px;
    object-fit: cover;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgBase)};
  }
  .ml-film-thumb-wrap {
    position: relative;
    width: 80px;
    height: 56px;
  }
  .ml-film-type {
    position: absolute;
    left: 4px;
    top: 4px;
    padding: 1px 5px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.72);
    color: #fff;
    font-size: 8px;
    font-weight: 800;
    letter-spacing: 0.04em;
    pointer-events: none;
  }
  .ml-film-pair {
    min-width: 170px;
  }
  .ml-film-pair-row {
    display: flex;
    gap: 2px;
  }
  .ml-film-half {
    width: 78px;
    height: 54px;
  }
  .ml-film-fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
  }
  .ml-film-idx {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
  }

  /* Compare: image slider */
  .ml-cmp-stage {
    position: relative;
    width: 100%;
    max-height: 72vh;
    aspect-ratio: auto;
    overflow: hidden;
    background: ${unsafeCSS(colors.bgBase)};
    border-radius: ${unsafeCSS(radii.sm)};
    cursor: ew-resize;
    touch-action: none;
    user-select: none;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ml-cmp-img {
    display: block;
    width: 100%;
    max-height: 72vh;
    object-fit: contain;
    user-select: none;
    pointer-events: none;
  }
  .ml-cmp-after {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .ml-cmp-divider {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: ${unsafeCSS(colors.accent)};
    transform: translateX(-1px);
    pointer-events: none;
  }
  .ml-cmp-handle {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: ${unsafeCSS(colors.bgCard)};
    border: 2px solid ${unsafeCSS(colors.accent)};
    color: ${unsafeCSS(colors.accent)};
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: bold;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  }
  .ml-cmp-label {
    position: absolute;
    top: 8px;
    padding: 2px 8px;
    border-radius: ${unsafeCSS(radii.sm)};
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    pointer-events: none;
  }
  .ml-cmp-label-l {
    left: 8px;
  }
  .ml-cmp-label-r {
    right: 8px;
  }
  .ml-cmp-label-static {
    position: static;
    align-self: flex-start;
    margin-bottom: 4px;
  }

  /* Compare: video grid */
  .ml-cmp-video-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${unsafeCSS(spacing.sm)};
    width: 100%;
  }
  .ml-cmp-video-cell {
    display: flex;
    flex-direction: column;
    background: ${unsafeCSS(colors.bgBase)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
  }
  .ml-cmp-video {
    width: 100%;
    max-height: 60vh;
    background: #000;
    border-radius: ${unsafeCSS(radii.sm)};
  }

  /* Compare: image side-by-side grid */
  .ml-cmp-image-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${unsafeCSS(spacing.sm)};
    width: 100%;
  }
  .ml-cmp-image-cell {
    display: flex;
    flex-direction: column;
    background: ${unsafeCSS(colors.bgBase)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    gap: 4px;
  }
  .ml-cmp-img-side {
    width: 100%;
    max-height: 78vh;
    object-fit: contain;
    background: #000;
    border-radius: ${unsafeCSS(radii.sm)};
  }
  .ml-btn.active {
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)}66;
  }

  /* Markdown viewer */
  .ml-md-shell {
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.sm)};
    width: 100%;
    max-width: 960px;
    margin: 0 auto;
  }
  .ml-md-toolbar {
    justify-content: space-between;
    padding: 0 4px;
  }
  .ml-md-body {
    max-height: 76vh;
    overflow: auto;
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.lg)} ${unsafeCSS(spacing.xl)};
    color: ${unsafeCSS(colors.textPrimary)};
    line-height: 1.6;
  }
  .ml-md-content h1,
  .ml-md-content h2,
  .ml-md-content h3,
  .ml-md-content h4 {
    color: ${unsafeCSS(colors.textPrimary)};
    margin: 1.2em 0 0.5em;
  }
  .ml-md-content h1 {
    font-size: 1.6rem;
  }
  .ml-md-content h2 {
    font-size: 1.3rem;
    border-bottom: 1px solid ${unsafeCSS(colors.textMuted)}33;
    padding-bottom: 4px;
  }
  .ml-md-content h3 {
    font-size: 1.1rem;
  }
  .ml-md-content p {
    margin: 0.6em 0;
  }
  .ml-md-content ul,
  .ml-md-content ol {
    padding-left: 1.4em;
    margin: 0.6em 0;
  }
  .ml-md-content li {
    margin: 0.2em 0;
  }
  .ml-md-content code {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 0.9em;
    background: ${unsafeCSS(colors.bgBase)};
    padding: 1px 5px;
    border-radius: 3px;
  }
  .ml-md-content pre {
    background: ${unsafeCSS(colors.bgBase)};
    padding: 10px 14px;
    border-radius: ${unsafeCSS(radii.sm)};
    overflow-x: auto;
    margin: 0.8em 0;
  }
  .ml-md-content pre code {
    background: transparent;
    padding: 0;
  }
  .ml-md-content table {
    border-collapse: collapse;
    margin: 0.8em 0;
  }
  .ml-md-content th,
  .ml-md-content td {
    border: 1px solid ${unsafeCSS(colors.textMuted)}33;
    padding: 4px 10px;
    font-size: ${unsafeCSS(fonts.sizeMd)};
  }
  .ml-md-content a {
    color: ${unsafeCSS(colors.accent)};
  }
  .ml-json-content {
    background: ${unsafeCSS(colors.bgBase)};
    padding: 12px 16px;
    border-radius: ${unsafeCSS(radii.sm)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeMd)};
    color: ${unsafeCSS(colors.textPrimary)};
    white-space: pre;
    overflow: auto;
    margin: 0;
    max-height: 100%;
  }
  .ml-diff-shell {
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.sm)};
    width: 100%;
    min-height: 0;
  }
  .ml-diff-body {
    height: min(76vh, 900px);
    min-height: 420px;
    overflow: hidden;
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.sm)};
  }
  .ml-diff-body diff-review {
    height: 100%;
    display: flex;
  }
  .ml-md-content blockquote {
    margin: 0.6em 0;
    padding: 4px 12px;
    border-left: 3px solid ${unsafeCSS(colors.accent)};
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .ml-md-content img {
    max-width: 100%;
  }

  .ml-film-md {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: ${unsafeCSS(colors.accent)};
    font-weight: 700;
    font-size: 11px;
    line-height: 1.2;
    text-align: center;
  }
  .ml-film-md span {
    color: ${unsafeCSS(colors.textMuted)};
    font-weight: 400;
    font-size: 9px;
    max-width: 72px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;
