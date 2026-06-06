import { html, nothing } from 'lit';

import type { GitBranchDiffFile, ReviewLineComment } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

import { workspaceArtifactBasename } from './workspace-artifacts.js';

const SEV_COLORS: Record<string, string> = {
  must_fix: '#ef4444',
  suggestion: '#f59e0b',
  nitpick: '#3b82f6',
  comment: '#6b7280',
};

const REC_COLORS: Record<string, string> = {
  APPROVE: '#00ff88',
  COMMENT: '#f59e0b',
  REQUEST_CHANGES: '#ef4444',
};

export function reviewSeverityCounts(
  comments: Pick<ReviewLineComment, 'severity'>[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const comment of comments) counts[comment.severity] = (counts[comment.severity] ?? 0) + 1;
  return counts;
}

export function reviewSeverityColor(severity: string): string {
  return SEV_COLORS[severity] ?? '#6b7280';
}

export function renderReviewLoadingBanner(phase: string | null) {
  if (!phase) return nothing;
  return html`
    <div class="rw-loading-banner" role="status" aria-live="polite">
      <span class="rw-loading-dot"></span>
      <span>${phase}</span>
    </div>
  `;
}

export function renderReviewBranchBanner(input: {
  slotBranch: string;
  branch: string;
  checkingOut: boolean;
  recovering: boolean;
  refresh: () => void;
  checkout: () => void;
}) {
  return html`
    <div class="rw-branch-banner">
      <span
        >Slot is on <strong>${input.slotBranch}</strong> — review targets
        <strong>${input.branch}</strong></span
      >
      <button class="rw-action-btn rw-btn-dismiss" @click=${input.refresh}>Refresh</button>
      <button
        class="rw-action-btn rw-btn-post"
        ?disabled=${input.checkingOut || input.recovering}
        @click=${input.checkout}
      >
        ${input.checkingOut ? 'Checking out...' : `Checkout ${input.branch}`}
      </button>
    </div>
  `;
}

export function renderReviewTopBar(input: {
  comments: ReviewLineComment[];
  includedComments: number;
  selectedRecommendation: string;
  setRecommendation: (recommendation: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE') => void;
  qualityCount: number | null;
  showQuality: boolean;
  toggleQuality: () => void;
  hasRecipe: boolean;
  showRecipe: boolean;
  toggleRecipe: () => void;
  hasLearnings: boolean;
  showLearnings: boolean;
  toggleLearnings: () => void;
  posting: boolean;
  recovering: boolean;
  refreshing: boolean;
  proposing: boolean;
  proposeError: string | null;
  pendingConfirm: string | null;
  refresh: () => void;
  proposeImprovement: () => void;
  post: () => void;
  dismiss: () => void;
}) {
  const counts = reviewSeverityCounts(input.comments);
  return html`
    <div class="rw-top-bar">
      <div class="rw-rec-selector">
        ${(['COMMENT', 'REQUEST_CHANGES', 'APPROVE'] as const).map((opt) => {
          const col = REC_COLORS[opt] ?? colors.textMuted;
          const active = input.selectedRecommendation === opt;
          return html` <button
            class="rw-rec-opt ${active ? 'active' : ''}"
            style="color:${col}; ${active ? `background:${col}22;` : ''}"
            @click=${() => input.setRecommendation(opt)}
          >
            ${opt}
          </button>`;
        })}
      </div>
      <span class="rw-comment-summary">
        ${input.includedComments}/${input.comments.length} comments
        ${Object.entries(counts).map(
          ([sev, n]) => html`
            <span
              class="rw-sev-pill"
              style="background:${reviewSeverityColor(sev)}22; color:${reviewSeverityColor(sev)}"
              >${n} ${sev}</span
            >
          `,
        )}
      </span>
      ${input.qualityCount !== null
        ? html`
            <button
              class="rw-panel-toggle ${input.showQuality ? 'active' : ''}"
              @click=${input.toggleQuality}
            >
              Quality (${input.qualityCount})
            </button>
          `
        : nothing}
      ${input.hasRecipe
        ? html`
            <button
              class="rw-panel-toggle ${input.showRecipe ? 'active' : ''}"
              @click=${input.toggleRecipe}
            >
              Recipe
            </button>
          `
        : nothing}
      ${input.hasLearnings
        ? html`
            <button
              class="rw-panel-toggle ${input.showLearnings ? 'active' : ''}"
              @click=${input.toggleLearnings}
            >
              Learnings
            </button>
          `
        : nothing}
      <span class="rw-spacer"></span>
      <button
        class="rw-panel-toggle"
        ?disabled=${input.posting || input.recovering || input.refreshing}
        title="Re-read review.md and line-comments.json from the worker. Preserves your comment selection."
        @click=${input.refresh}
      >
        ${input.refreshing ? 'Refreshing…' : '↻ Refresh artifacts'}
      </button>
      ${input.hasLearnings
        ? html`
            <button
              class="rw-panel-toggle"
              ?disabled=${input.posting || input.recovering || input.proposing}
              title="Fire-and-forget LLM call. Analyzes learnings.md and proposes a recipe/process improvement. Decision arrives in timeline when done (~30–120s)."
              @click=${input.proposeImprovement}
            >
              ${input.proposing ? 'Analyzing…' : 'Propose improvement (LLM)'}
            </button>
            ${input.proposeError
              ? html`<span style="color:${colors.statusFail}; font-size:11px; margin-left:8px"
                  >${input.proposeError}</span
                >`
              : nothing}
          `
        : nothing}
      <button
        class="rw-action-btn ${input.pendingConfirm === 'post' ? 'rw-confirming' : 'rw-btn-post'}"
        ?disabled=${input.posting || input.recovering}
        @click=${input.post}
      >
        ${input.posting
          ? 'Posting...'
          : input.pendingConfirm === 'post'
            ? `Confirm Post (${input.includedComments})?`
            : `Post to PR (${input.includedComments})`}
      </button>
      <button
        class="rw-action-btn ${input.pendingConfirm === 'dismiss'
          ? 'rw-confirming'
          : 'rw-btn-dismiss'}"
        ?disabled=${input.posting || input.recovering}
        @click=${input.dismiss}
      >
        ${input.pendingConfirm === 'dismiss' ? 'Confirm Dismiss?' : 'Dismiss'}
      </button>
    </div>
  `;
}

export function renderReviewFileTab(input: {
  file: GitBranchDiffFile;
  selectedFile: string;
  commentCount: number;
  recovering: boolean;
  selectFile: (path: string) => void;
}) {
  const { file } = input;
  const selected = input.selectedFile === file.path;
  const statusColors: Record<string, string> = {
    M: '#6366f1',
    A: '#00ff88',
    D: '#ff4444',
    R: '#ffcc00',
  };
  const basename = workspaceArtifactBasename(file.path);

  return html`
    <button
      class="rw-ft ${selected ? 'selected' : ''}"
      ?disabled=${input.recovering}
      @click=${() => input.selectFile(file.path)}
      title=${file.path}
    >
      <span style="color:${statusColors[file.status] ?? colors.textMuted}; font-weight:700"
        >${file.status}</span
      >
      <span>${basename}</span>
      ${input.commentCount > 0
        ? html`
            <span
              class="rw-fc-badge"
              style="background:${colors.statusWarn}22; color:${colors.statusWarn}"
              >${input.commentCount}</span
            >
          `
        : nothing}
      <span style="color:${colors.textMuted}; font-size:10px"
        >+${file.additions} -${file.deletions}</span
      >
    </button>
  `;
}

export function renderReviewCommentItem(input: {
  comment: ReviewLineComment;
  selected: boolean;
  included: boolean;
  toggle: () => void;
  navigate: () => void;
}) {
  const { comment } = input;
  const sevColor = reviewSeverityColor(comment.severity);
  const basename = workspaceArtifactBasename(comment.path);

  return html`
    <div class="rw-ci ${input.selected ? 'active' : ''}" @click=${input.navigate}>
      <input
        type="checkbox"
        .checked=${input.included}
        @click=${(event: Event) => event.stopPropagation()}
        @change=${input.toggle}
      />
      <div class="rw-ci-content">
        <div class="rw-ci-meta">
          <span class="rw-sev-pill" style="background:${sevColor}22; color:${sevColor}"
            >${comment.severity}</span
          >
          <span class="rw-ci-path" title=${comment.path}>${basename}:${comment.line}</span>
        </div>
        <div class="rw-ci-body">${comment.body}</div>
      </div>
    </div>
  `;
}
