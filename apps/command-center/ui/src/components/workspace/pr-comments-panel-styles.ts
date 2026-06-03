import { css, unsafeCSS } from 'lit';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

export const prCommentsPanelStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    height: 100%;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    color: ${unsafeCSS(colors.textPrimary)};
  }

  /* --- Filter bar --- */
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-bottom: 1px solid #1e1e36;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .filter-group {
    display: flex;
    gap: 1px;
  }

  .filter-btn {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    padding: 2px 8px;
    border: 1px solid #2a2a44;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    transition: all 0.1s;
  }
  .filter-btn:first-child {
    border-radius: 4px 0 0 4px;
  }
  .filter-btn:last-child {
    border-radius: 0 4px 4px 0;
  }
  .filter-btn:only-child {
    border-radius: 4px;
  }
  .filter-btn.active {
    background: ${unsafeCSS(colors.accent)}22;
    border-color: ${unsafeCSS(colors.accent)}44;
    color: ${unsafeCSS(colors.accent)};
  }
  .filter-btn:hover:not(.active) {
    color: ${unsafeCSS(colors.textSecondary)};
    background: rgba(99, 102, 241, 0.05);
  }

  .filter-count {
    font-size: 9px;
    margin-left: 3px;
    opacity: 0.7;
  }

  .filter-sep {
    width: 1px;
    height: 16px;
    background: #2a2a44;
    margin: 0 4px;
  }

  .pr-badge {
    font-size: 10px;
    color: ${unsafeCSS(colors.accent)};
    font-weight: 600;
    margin-left: auto;
  }

  .refresh-btn {
    background: none;
    border: none;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;
  }
  .refresh-btn:hover {
    color: ${unsafeCSS(colors.textPrimary)};
  }

  /* --- Content --- */
  .content {
    flex: 1;
    overflow-y: auto;
  }
  .content::-webkit-scrollbar {
    width: 6px;
  }
  .content::-webkit-scrollbar-thumb {
    background: ${unsafeCSS(colors.textMuted)};
    border-radius: 3px;
  }

  .loading,
  .empty {
    padding: ${unsafeCSS(spacing.lg)};
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }

  /* --- File group --- */
  .file-group {
    border-bottom: 1px solid #1e1e3622;
  }

  .file-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textSecondary)};
    font-weight: 600;
    cursor: pointer;
    user-select: none;
  }
  .file-header:hover {
    background: rgba(99, 102, 241, 0.05);
  }
  .file-badge {
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
    padding: 0 5px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 600;
    margin-left: auto;
  }

  /* --- Thread --- */
  .thread {
    padding: 4px 8px 4px 20px;
    cursor: pointer;
    border-left: 2px solid transparent;
    transition: background 0.1s;
  }
  .thread:hover {
    background: rgba(99, 102, 241, 0.05);
  }
  .thread.expanded {
    background: rgba(99, 102, 241, 0.08);
    border-left-color: ${unsafeCSS(colors.accent)}44;
  }
  .thread.resolved {
    opacity: 0.5;
  }
  .thread.resolved:hover {
    opacity: 0.8;
  }

  .thread-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }

  .author {
    font-weight: 600;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .author.bot {
    color: ${unsafeCSS(colors.textMuted)};
  }

  .line-num {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
  }

  .status-badge {
    font-size: 9px;
    padding: 0 4px;
    border-radius: 3px;
    font-weight: 600;
  }
  .status-badge.resolved {
    background: ${unsafeCSS(colors.statusOk)}22;
    color: ${unsafeCSS(colors.statusOk)};
  }
  .status-badge.outdated {
    background: ${unsafeCSS(colors.statusWarn)}22;
    color: ${unsafeCSS(colors.statusWarn)};
  }

  .thread-time {
    color: ${unsafeCSS(colors.textMuted)};
    margin-left: auto;
    font-size: 10px;
  }

  .thread-body {
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    margin-top: 2px;
    max-height: 60px;
    overflow: hidden;
  }
  .thread.expanded .thread-body {
    max-height: none;
  }

  .reply-count {
    font-size: 10px;
    color: ${unsafeCSS(colors.accent)};
    margin-top: 2px;
  }

  /* --- Expanded thread detail --- */
  .thread-detail {
    padding: 4px 0 8px 0;
  }

  .thread-comment {
    padding: 4px 0;
    border-top: 1px solid #1e1e3622;
  }
  .thread-comment:first-child {
    border-top: none;
  }

  .comment-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: ${unsafeCSS(fonts.sizeXs)};
    margin-bottom: 2px;
  }

  .comment-body {
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* --- Thread actions --- */
  .thread-actions {
    display: flex;
    gap: 4px;
    margin-top: 6px;
    padding-top: 4px;
    border-top: 1px solid #1e1e3622;
  }

  .action-btn {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    padding: 2px 8px;
    border: 1px solid #2a2a44;
    border-radius: 3px;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
  }
  .action-btn:hover {
    color: ${unsafeCSS(colors.textPrimary)};
    background: rgba(99, 102, 241, 0.08);
  }
  .action-btn.resolve {
    border-color: ${unsafeCSS(colors.statusOk)}44;
    color: ${unsafeCSS(colors.statusOk)};
  }
  .action-btn.resolve:hover {
    background: ${unsafeCSS(colors.statusOk)}22;
  }

  /* --- Reply form --- */
  .reply-form {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .reply-input {
    width: 100%;
    padding: 4px 6px;
    border: 1px solid #2a2a44;
    border-radius: 3px;
    background: ${unsafeCSS(colors.bgInput)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    resize: vertical;
    min-height: 40px;
    outline: none;
    box-sizing: border-box;
  }
  .reply-input:focus {
    border-color: ${unsafeCSS(colors.accent)};
  }

  .reply-actions {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
  }

  .reply-submit {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    padding: 2px 10px;
    border: 1px solid ${unsafeCSS(colors.accent)}44;
    border-radius: 3px;
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
    cursor: pointer;
  }
  .reply-submit:hover {
    background: ${unsafeCSS(colors.accent)}33;
  }
  .reply-submit:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  .reply-cancel {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    padding: 2px 10px;
    border: 1px solid #2a2a44;
    border-radius: 3px;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
  }
  .reply-cancel:hover {
    color: ${unsafeCSS(colors.textPrimary)};
  }

  /* --- New comment form --- */
  .new-comment-form {
    padding: 6px 8px;
    border-bottom: 1px solid ${unsafeCSS(colors.accent)}44;
    background: ${unsafeCSS(colors.accent)}08;
  }
  .new-comment-header {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
    margin-bottom: 4px;
  }
  .new-comment-header strong {
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .new-comment-input {
    width: 100%;
    padding: 4px 6px;
    border: 1px solid ${unsafeCSS(colors.accent)}44;
    border-radius: 3px;
    background: ${unsafeCSS(colors.bgInput)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    resize: vertical;
    min-height: 40px;
    outline: none;
    box-sizing: border-box;
  }
  .new-comment-input:focus {
    border-color: ${unsafeCSS(colors.accent)};
  }

  /* --- Markdown body styles --- */
  .md-body p {
    margin: 2px 0;
  }
  .md-body pre {
    background: ${unsafeCSS(colors.bgBase)};
    border: 1px solid #2a2a44;
    border-radius: 3px;
    padding: 4px 6px;
    font-size: 10px;
    overflow-x: auto;
    margin: 4px 0;
  }
  .md-body code {
    background: ${unsafeCSS(colors.bgBase)};
    padding: 1px 4px;
    border-radius: 2px;
    font-size: 10px;
    color: ${unsafeCSS(colors.accent)};
  }
  .md-body pre code {
    background: none;
    padding: 0;
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .md-body a {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
  }
  .md-body a:hover {
    text-decoration: underline;
  }
  .md-body blockquote {
    border-left: 2px solid #2a2a44;
    margin: 4px 0;
    padding: 2px 8px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .md-body ul,
  .md-body ol {
    margin: 2px 0;
    padding-left: 16px;
  }
  .md-body img {
    max-width: 100%;
    border-radius: 3px;
  }
  .md-body h1,
  .md-body h2,
  .md-body h3 {
    font-size: ${unsafeCSS(fonts.sizeSm)};
    margin: 4px 0 2px;
  }

  .comment-actions {
    display: flex;
    gap: 4px;
    margin-top: 2px;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .thread-comment:hover .comment-actions {
    opacity: 1;
  }

  .comment-action-btn {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 9px;
    padding: 1px 5px;
    border: 1px solid #2a2a44;
    border-radius: 2px;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
  }
  .comment-action-btn:hover {
    color: ${unsafeCSS(colors.textPrimary)};
    background: rgba(99, 102, 241, 0.08);
  }
  .comment-action-btn.danger:hover {
    color: ${unsafeCSS(colors.statusFail)};
    background: rgba(255, 68, 68, 0.08);
  }
  .comment-action-btn.confirming {
    color: ${unsafeCSS(colors.statusWarn)};
    border-color: ${unsafeCSS(colors.statusWarn)}44;
    background: ${unsafeCSS(colors.statusWarn)}11;
    opacity: 1;
  }

  .edit-form {
    margin-top: 4px;
  }

  .edit-input {
    width: 100%;
    padding: 4px 6px;
    border: 1px solid ${unsafeCSS(colors.accent)}44;
    border-radius: 3px;
    background: ${unsafeCSS(colors.bgInput)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    resize: vertical;
    min-height: 40px;
    outline: none;
    box-sizing: border-box;
  }
  .edit-input:focus {
    border-color: ${unsafeCSS(colors.accent)};
  }

  .review-form {
    padding: 6px 8px;
    border-bottom: 1px solid #1e1e36;
  }
  .review-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .review-label {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
    font-weight: 600;
  }
  .review-input {
    width: 100%;
    padding: 4px 6px;
    border: 1px solid #2a2a44;
    border-radius: 3px;
    background: ${unsafeCSS(colors.bgInput)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    resize: vertical;
    min-height: 50px;
    outline: none;
    box-sizing: border-box;
  }
  .review-input:focus {
    border-color: ${unsafeCSS(colors.accent)};
  }

  .review-btn {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    padding: 2px 8px;
    border: 1px solid #2a2a44;
    border-radius: 3px;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
  }
  .review-btn:hover {
    color: ${unsafeCSS(colors.textPrimary)};
    background: rgba(99, 102, 241, 0.08);
  }
  .review-btn.primary {
    border-color: ${unsafeCSS(colors.statusOk)}44;
    color: ${unsafeCSS(colors.statusOk)};
  }
  .review-btn.primary:hover {
    background: ${unsafeCSS(colors.statusOk)}22;
  }
  .review-btn:disabled {
    opacity: 0.5;
    cursor: wait;
  }
`;
