import { html, nothing } from 'lit';

import type {
  ArtifactRef,
  GitBranchDiffFile,
  ReadyGatePayload,
  RunDecision,
} from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

import { readyReviewBlockingReason } from './ready-workspace-renderers.js';
import { workspaceArtifactBasename } from './workspace-artifacts.js';
import type { ReadyWorkspaceTab } from './workspace-url-state.js';

export function renderReadyTopBar(input: {
  payload: ReadyGatePayload;
  decision?: RunDecision;
  publicationTarget: 'draft' | 'ready';
  pendingConfirm: string | null;
  acting: boolean;
  recovering: boolean;
  diffArtifact?: ArtifactRef;
  fileDiffAvailable: boolean;
  actionMessage: string;
  actionTone: 'success' | 'error' | '';
  openDiff: (title: string, artifact?: ArtifactRef) => void;
  openReviewRequestModal: () => void;
  confirmAction: (actionId: string) => void;
}) {
  const { branch, prNumber, repo, diffStat } = input.payload;
  const prUrl = prNumber && repo ? `https://github.com/${repo}/pull/${prNumber}` : null;
  const packageGate = !!input.payload.prPackage;
  const hasApprovePublish =
    input.decision?.actions?.some((action) => action.id === 'approve-publish') ?? false;
  const canApprove =
    input.decision?.actions?.some(
      (action) => action.id === 'approve-publish' || action.id === 'ready',
    ) ?? !packageGate;
  const reviewBlockingReason =
    packageGate && !canApprove ? readyReviewBlockingReason(input.payload) : '';
  const approveLabel = hasApprovePublish
    ? `Approve Publish (${input.publicationTarget === 'ready' ? 'ready' : 'draft'})`
    : 'Mark Ready';
  const approveActionId = hasApprovePublish ? 'approve-publish' : 'ready';
  const pendingApproveConfirm = input.pendingConfirm === approveActionId;

  return html`
    <div class="rdy-top-bar">
      <span class="rdy-branch">${branch}</span>
      ${prUrl
        ? html`
            <a class="rdy-pr-link" href=${prUrl} target="_blank" rel="noopener">#${prNumber}</a>
          `
        : html`<span class="rdy-pr-link rdy-local-only">local package</span>`}
      <button
        class="rdy-diff-stat"
        title="Open diff viewer"
        ?disabled=${!input.diffArtifact && !input.fileDiffAvailable}
        @click=${() => input.openDiff(`${branch} diff`, input.diffArtifact)}
      >
        <span class="rdy-stat-add">+${diffStat.additions}</span>
        <span class="rdy-stat-del">-${diffStat.deletions}</span>
        <span class="rdy-stat-files">${diffStat.files} files</span>
      </button>
      ${input.actionMessage
        ? html`
            <div
              class="rdy-action-feedback ${input.actionTone === 'error'
                ? 'error'
                : input.actionTone === 'success'
                  ? 'success'
                  : ''}"
            >
              ${input.actionMessage}
            </div>
          `
        : nothing}
      <span class="rdy-spacer"></span>
      ${input.decision?.resolvedAt
        ? html`
            <!-- Resolved gate: render the decision outcome instead of live actions.
             Workspace is now read-only; actions would re-resolve an already-
             resolved decision. Users revisiting the slot still get the full
             report / diff / recipe / artifacts panes for post-hoc review. -->
            <span class="rdy-resolved-badge" title="Resolved at ${input.decision.resolvedAt}">
              Resolved · ${input.decision.resolvedAction ?? 'done'}
            </span>
          `
        : html`
            ${packageGate && input.decision?.actions?.some((a) => a.id === 'request-extra-review')
              ? html`
                  <button
                    class="rdy-btn rdy-btn-secondary"
                    ?disabled=${input.acting || input.recovering}
                    @click=${input.openReviewRequestModal}
                  >
                    Extra Review
                  </button>
                `
              : nothing}
            <button
              class="rdy-btn ${pendingApproveConfirm ? 'rdy-confirming' : 'rdy-btn-primary'}"
              ?disabled=${input.acting || input.recovering || !canApprove}
              title=${canApprove
                ? ''
                : reviewBlockingReason || 'Required independent review policy is not satisfied yet'}
              @click=${() => input.confirmAction(approveActionId)}
            >
              ${input.acting
                ? 'Submitting…'
                : pendingApproveConfirm
                  ? 'Confirm Publish?'
                  : canApprove
                    ? approveLabel
                    : reviewBlockingReason || 'Review Required'}
            </button>
          `}
    </div>
  `;
}

export function renderReadyTabBar(input: {
  payload: ReadyGatePayload;
  activeTab: ReadyWorkspaceTab;
  hideRecipeTab: boolean;
  evidenceCount: number;
  qualityCount: number;
  inputCount: number;
  diffFileCount: number;
  setActiveTab: (tab: ReadyWorkspaceTab) => void;
}) {
  const hasRecipe = !!input.payload.recipeJson && !input.hideRecipeTab;
  const hasEvidence = input.evidenceCount > 0;
  const hasQuality = input.qualityCount > 0;
  const hasInput = input.inputCount > 0;
  const hasLearnings = !!input.payload.workerLearnings;
  const hasPreview = !!input.payload.prPackage;

  return html`
    <div class="rdy-tab-bar">
      ${hasPreview
        ? html`
            <button
              class="rdy-tab ${input.activeTab === 'pr-preview' ? 'active' : ''}"
              @click=${() => input.setActiveTab('pr-preview')}
            >
              PR Preview
            </button>
          `
        : nothing}
      ${hasInput
        ? html`
            <button
              class="rdy-tab ${input.activeTab === 'input' ? 'active' : ''}"
              @click=${() => input.setActiveTab('input')}
            >
              Input (${input.inputCount})
            </button>
          `
        : nothing}
      <button
        class="rdy-tab ${input.activeTab === 'diff' ? 'active' : ''}"
        @click=${() => input.setActiveTab('diff')}
      >
        Diff (${input.diffFileCount})
      </button>
      ${hasEvidence
        ? html`
            <button
              class="rdy-tab ${input.activeTab === 'evidence' ? 'active' : ''}"
              @click=${() => input.setActiveTab('evidence')}
            >
              Evidence (${input.evidenceCount})
            </button>
          `
        : nothing}
      ${hasQuality
        ? html`
            <button
              class="rdy-tab ${input.activeTab === 'quality' ? 'active' : ''}"
              @click=${() => input.setActiveTab('quality')}
            >
              Quality (${input.qualityCount})
            </button>
          `
        : nothing}
      ${hasRecipe
        ? html`
            <button
              class="rdy-tab ${input.activeTab === 'recipe' ? 'active' : ''}"
              @click=${() => input.setActiveTab('recipe')}
            >
              Recipe
            </button>
          `
        : nothing}
      ${hasLearnings
        ? html`
            <button
              class="rdy-tab ${input.activeTab === 'learnings' ? 'active' : ''}"
              @click=${() => input.setActiveTab('learnings')}
            >
              Learnings
            </button>
          `
        : nothing}
    </div>
  `;
}

export function renderReadyDiffTab(input: {
  slotId: string;
  diffLoading: boolean;
  diffError: string;
  diffFiles: GitBranchDiffFile[];
  selectedFile: string;
  recovering: boolean;
  fileDiffLoading: boolean;
  fileDiff: string;
  selectFile: (path: string) => void;
}) {
  if (!input.slotId) return html`<div class="rdy-tab-empty">No slot — diff not available</div>`;
  if (input.diffLoading) return html`<div class="rdy-tab-empty">Loading diff...</div>`;
  if (input.diffError) return html`<div class="rdy-tab-empty">${input.diffError}</div>`;
  if (input.diffFiles.length === 0) return html`<div class="rdy-tab-empty">No changed files</div>`;

  const statusColors: Record<string, string> = {
    M: '#6366f1',
    A: '#00ff88',
    D: '#ff4444',
    R: '#ffcc00',
  };

  return html`
    <div class="rdy-diff-area">
      <div class="rdy-file-tabs">
        ${input.diffFiles.map((file) => {
          const selected = input.selectedFile === file.path;
          const basename = workspaceArtifactBasename(file.path);
          return html`
            <button
              class="rdy-ft ${selected ? 'selected' : ''}"
              ?disabled=${input.recovering}
              @click=${() => input.selectFile(file.path)}
              title=${file.path}
            >
              <span style="color:${statusColors[file.status] ?? colors.textMuted}; font-weight:700"
                >${file.status}</span
              >
              <span>${basename}</span>
              <span style="color:${colors.textMuted}; font-size:10px"
                >+${file.additions} -${file.deletions}</span
              >
            </button>
          `;
        })}
      </div>
      <div class="rdy-diff-content">
        ${input.fileDiffLoading
          ? html`<div class="rdy-tab-empty">Loading file diff...</div>`
          : input.fileDiff
            ? html`
                <diff-review
                  .diff=${input.fileDiff}
                  .filename=${workspaceArtifactBasename(input.selectedFile)}
                ></diff-review>
              `
            : html`<div class="rdy-tab-empty">Select a file</div>`}
      </div>
    </div>
  `;
}
