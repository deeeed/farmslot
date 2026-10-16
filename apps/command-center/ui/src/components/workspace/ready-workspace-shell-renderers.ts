import { html, nothing } from 'lit';

import type { EvidenceReviewJudgmentRow } from '@farmslot/adapter-sdk/evidence';
import {
  type ArtifactRef,
  deriveRunLifecycleView,
  type GitBranchDiffFile,
  type ReadyGatePayload,
  type RunDecision,
} from '@farmslot/protocol';
import {
  PUBLICATION_GATE_TABS,
  type PublicationGateAction,
  type PublicationGateClaim,
} from '@farmslot/review-dispatch';

import { colors } from '../../styles/theme-tokens.js';
import type { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';

import { renderPublicationGatePanel } from './publication-gate-panel.js';
import { readyReviewBlockingReason } from './ready-workspace-renderers.js';
import { workspaceArtifactBasename } from './workspace-artifacts.js';
import type { ReadyWorkspaceTab } from './workspace-url-state.js';

export function renderReadyTopBar(input: {
  payload: ReadyGatePayload;
  decision?: RunDecision;
  publicationTarget: 'draft' | 'ready';
  pendingConfirm: string | null;
  attestationReason?: string;
  attesting?: boolean;
  chooseAttestation?: () => void;
  setAttestationReason?: (value: string) => void;
  acting: boolean;
  showClaims?: boolean;
  feedback?: import('@farmslot/review-dispatch').VisualJudgmentFeedback;
  pausedReason?: string;
  pausedRetry?: () => void;
  loading?: boolean;
  loadError?: string;
  retry?: () => void;
  recovering: boolean;
  diffArtifact?: ArtifactRef;
  fileDiffAvailable: boolean;
  actionMessage: string;
  reviewProgress?: string;
  actionTone: 'success' | 'error' | '';
  openDiff: (title: string, artifact?: ArtifactRef) => void;
  openReviewRequestModal: () => void;
  confirmAction: (actionId: string) => void;
  claims?: readonly PublicationGateClaim[];
  judgmentRows?: readonly EvidenceReviewJudgmentRow[];
  reviewReason?: (id: string) => string;
  changeReviewReason?: (id: string, reason: string) => void;
  recordReview?: (id: string, verdict: 'confirmed' | 'rejected') => void;
  refreshPackage?: () => void;
  pendingVisualClaimIds?: readonly string[];
  focusClaim?: (id: string) => void | Promise<void>;
}) {
  const actions: readonly PublicationGateAction[] =
    input.decision?.actions ??
    (!input.payload.prPackage ? [{ id: 'ready', label: 'Mark Ready', style: 'primary' }] : []);
  return html`
    ${renderPublicationGatePanel({
      actions,
      showClaims: input.showClaims,
      feedback: input.feedback,
      loading: input.loading,
      loadError: input.loadError,
      retry: input.retry,
      claims: input.claims,
      judgmentRows: input.judgmentRows,
      reviewReason: input.reviewReason,
      changeReviewReason: input.changeReviewReason,
      recordReview: input.recordReview,
      refreshPackage: input.refreshPackage,
      pendingVisualClaimIds: input.pendingVisualClaimIds,
      readiness: input.payload.gateReadiness,
      reviewSummary: input.payload.gateSummary?.review,
      blockedReason: readyReviewBlockingReason(input.payload),
      attestationReason: input.attestationReason,
      attesting: input.attesting,
      chooseAttestation: () => input.chooseAttestation?.(),
      resolved: Boolean(input.decision?.resolvedAt),
      busy: input.acting,
      pausedRetry: input.pausedRetry,
      pausedReason:
        input.pausedReason || (input.recovering ? 'Reconnecting; actions paused' : undefined),
      pendingConfirm: input.pendingConfirm,
      reviewDisabled: input.payload.reviewRoundBudget?.remaining === 0,
      changeReason: (reason) => input.setAttestationReason?.(reason),
      focusClaim: input.focusClaim,
      invoke: input.confirmAction,
      requestReview: input.openReviewRequestModal,
    })}
    ${input.actionMessage && (!input.reviewProgress || input.actionTone === 'error')
      ? html`<div
          class="rdy-action-feedback ${input.actionTone}"
          role=${input.actionTone === 'error' ? 'alert' : 'status'}
        >
          ${input.actionMessage}
        </div>`
      : nothing}
    ${input.reviewProgress
      ? html`<div role="status" class="rdy-action-feedback" data-testid="rdy-review-progress">
          ${input.reviewProgress}
        </div>`
      : nothing}
  `;
}

export function renderReadyTabBar(input: {
  payload: ReadyGatePayload;
  activeTab: ReadyWorkspaceTab;
  packagePending?: boolean;
  hideRecipeTab: boolean;
  evidenceCount: number;
  qualityCount: number;
  inputCount: number;
  /** Diff tab file count, `5 of 12` while tests are hidden. */
  diffCount: string;
  setActiveTab: (tab: ReadyWorkspaceTab) => void;
}) {
  const hasRecipe = !!input.payload.recipeJson && !input.hideRecipeTab;
  const hasEvidence = input.evidenceCount > 0;
  const hasQuality = input.qualityCount > 0;
  const hasInput = input.inputCount > 0;
  const hasLearnings = !!input.payload.workerLearnings;
  const hasPreview = Boolean(input.payload.prPackage || input.packagePending);

  if (input.payload.prPackage)
    return html` <div class="rdy-tab-bar" role="tablist" aria-label="Publication gate">
      ${PUBLICATION_GATE_TABS.map(
        (tab) =>
          html`<button
            role="tab"
            class="rdy-tab ${input.activeTab === tab.id ? 'active' : ''}"
            aria-selected=${input.activeTab === tab.id}
            @click=${() => input.setActiveTab(tab.id)}
          >
            ${tab.label}
          </button>`,
      )}
      <details class="gate-extra-tabs">
        <summary>More views</summary>
        ${(['diff', 'input', 'recipe', 'learnings'] as const).map(
          (id) =>
            html`<button class="rdy-tab" @click=${() => input.setActiveTab(id)}>${id}</button>`,
        )}
      </details>
    </div>`;
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
        Diff (${input.diffCount})
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
  retryDiff?: () => void;
  diffFiles: GitBranchDiffFile[];
  testFilter: DiffTestFilterController;
  selectedFile: string;
  recovering: boolean;
  fileDiffLoading: boolean;
  fileDiff: string;
  selectFile: (path: string) => void;
}) {
  if (!input.slotId) return html`<div class="rdy-tab-empty">No slot — diff not available</div>`;
  if (input.diffLoading) return renderReadyDiffSkeleton();
  if (input.diffError) return renderReadyDiffSkeleton(input.diffError, input.retryDiff);
  if (input.diffFiles.length === 0) return html`<div class="rdy-tab-empty">No changed files</div>`;
  const split = input.testFilter.split(input.diffFiles);
  const allHidden = split.visible.length === 0;

  const statusColors: Record<string, string> = {
    M: '#6366f1',
    A: '#00ff88',
    D: '#ff4444',
    R: '#ffcc00',
  };

  return html`
    <div class="rdy-diff-area">
      <div class="rdy-file-tabs">
        ${input.testFilter.renderControls(split.summary)}
        ${split.visible.map((file) => {
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
        ${allHidden
          ? html`<div class="rdy-tab-empty">
              Only test files changed — show tests to review them
            </div>`
          : input.fileDiffLoading
            ? renderReadyDiffSkeleton()
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

export function renderReadyPackageMetadata(input: Parameters<typeof renderReadyTopBar>[0]) {
  const { branch, prNumber, repo, diffStat } = input.payload;
  const lifecycle = deriveRunLifecycleView({
    status: 'human-gating',
    gateReadiness: input.payload.gateReadiness,
  });
  const prUrl = prNumber && repo ? `https://github.com/${repo}/pull/${prNumber}` : null;
  return html` <section class="rdy-gate-details">
    <div class="rdy-top-bar">
      <span class="rdy-branch">${branch}</span>
      ${input.payload.reviewRoundBudget
        ? html`<span role="status" data-testid="rdy-review-round-budget"
            >${input.payload.reviewRoundBudget.label}</span
          >`
        : nothing}
      ${input.decision?.resolvedAt
        ? html`<span class="rdy-resolved-badge"
            >Resolved · ${input.decision.resolvedAction ?? 'done'}</span
          >`
        : lifecycle.gateLabel
          ? html`<span role="status">${lifecycle.gateLabel}</span>`
          : nothing}
      ${prUrl
        ? html`<a class="rdy-pr-link" href=${prUrl} target="_blank" rel="noopener">#${prNumber}</a>`
        : html`<span class="rdy-pr-link rdy-local-only">local package</span>`}
      <button
        class="rdy-diff-stat"
        title="Open diff viewer"
        ?disabled=${!input.diffArtifact && !input.fileDiffAvailable}
        @click=${() => input.openDiff(`${branch} diff`, input.diffArtifact)}
      >
        <span class="rdy-stat-add">+${diffStat.additions}</span
        ><span class="rdy-stat-del">-${diffStat.deletions}</span
        ><span class="rdy-stat-files">${diffStat.files} files</span>
      </button>
    </div>
  </section>`;
}

function renderReadyDiffSkeleton(error = '', retry?: () => void) {
  return html`<farm-hydrating message="Loading diff" .error=${error} @retry=${retry}
    ><div style="display:grid;gap:12px;min-height:300px">
      <div style="display:flex;gap:12px">
        <farm-skeleton kind="button" width="100px"></farm-skeleton
        ><farm-skeleton kind="button" width="120px"></farm-skeleton>
      </div>
      ${Array.from(
        { length: 9 },
        (_, index) =>
          html`<farm-skeleton width=${index % 3 === 2 ? '60%' : '90%'}></farm-skeleton>`,
      )}
    </div></farm-hydrating
  >`;
}
