import { html, nothing } from 'lit';

import type { ArtifactRef, PublicationTarget, ReadyGatePayload } from '@farmslot/protocol';

import '../reviews/gate-summary-panel.js';

import {
  publishEvidenceDisplayRows,
  summarizeReviewCounts,
} from '../../utils/review-gate-display.js';
import type { ReviewLoopArtifactOpenDetail } from '../reviews/review-loop-timeline.js';

export interface ReadyPackagePanelContext {
  payload: ReadyGatePayload;
  packageArtifact?: ArtifactRef;
  publishEvidence: ArtifactRef[];
  selectedEvidence: Set<string>;
  selectedEvidenceKeys?: string[];
  expanded: boolean;
  resolved: boolean;
  refreshingPackage: boolean;
  acting: boolean;
  recovering: boolean;
  publicationTarget: PublicationTarget;
  openPackageArtifact: (artifact: ArtifactRef) => void;
  toggleExpanded: () => void;
  refreshPackage: () => void | Promise<void>;
  setPublicationTarget: (target: PublicationTarget) => void;
  artifactUrl: (artifact: ArtifactRef) => string;
  openReviewArtifact: (detail: ReviewLoopArtifactOpenDetail) => void;
  openReviewDiff: (detail: ReviewLoopArtifactOpenDetail) => void;
}

export function renderReadyPackagePanel(ctx: ReadyPackagePanelContext) {
  const reviewSummary = summarizeReviewCounts(ctx.payload);
  const selectedEvidenceCount = ctx.publishEvidence.filter((artifact) =>
    ctx.selectedEvidence.has(artifact.path),
  ).length;
  return html`
    <div class="rdy-package-panel">
      ${ctx.payload.gateSummary
        ? html`<gate-summary-panel .summary=${ctx.payload.gateSummary}></gate-summary-panel>`
        : nothing}
      <div class="rdy-package-summary">
        <strong>Pre-publication cockpit</strong>
        ${ctx.packageArtifact && ctx.payload.prPackage
          ? html`
              <button
                class="rdy-cockpit-link"
                title="Open PR package markdown"
                @click=${() => ctx.openPackageArtifact(ctx.packageArtifact!)}
              >
                Package ${ctx.payload.prPackage.id} ·
                ${ctx.payload.prPackage.packageHash.slice(0, 12)}
              </button>
            `
          : html`<span
              >Package ${ctx.payload.prPackage?.id ?? 'unavailable'} ·
              ${ctx.payload.prPackage?.packageHash?.slice(0, 12) ?? 'no hash'}</span
            >`}
        <span
          >${reviewSummary.fixLoopCertified ? 'Trusted passing reviews' : 'Fresh passing reviews'}
          ${reviewSummary.trustedPassingReviews}/${reviewSummary.requiredReviews}</span
        >
        ${reviewSummary.fixLoopCertified
          ? html`<span>Full-live fix-loop certification present</span>`
          : nothing}
        <span>Attempts ${reviewSummary.totalAttempts}</span>
        ${reviewSummary.staleIgnoredReviews
          ? html`<span>Stale ignored ${reviewSummary.staleIgnoredReviews}</span>`
          : nothing}
        ${reviewSummary.externalRequired
          ? html`<span
              >Runner diversity
              ${reviewSummary.externalFreshPassingReviews ? 'present' : 'required'}</span
            >`
          : nothing}
        ${ctx.publishEvidence.length
          ? html`<span
              >Evidence selected ${selectedEvidenceCount}/${ctx.publishEvidence.length}</span
            >`
          : nothing}
        <span>${reviewSummary.unresolvedFindings} unresolved</span>
        <button class="rdy-cockpit-link" @click=${ctx.toggleExpanded}>
          ${ctx.expanded ? 'Hide details' : 'Show details'}
        </button>
        ${ctx.resolved
          ? nothing
          : html`
              <button
                class="rdy-cockpit-link"
                ?disabled=${ctx.refreshingPackage || ctx.acting || ctx.recovering}
                title="Rebuild pr-package.json from the current workspace artifacts, PR body, evidence, diff, and HEAD"
                @click=${ctx.refreshPackage}
              >
                ${ctx.refreshingPackage ? 'Refreshing package…' : 'Refresh package'}
              </button>
            `}
      </div>
      ${ctx.expanded
        ? html`
            <div class="rdy-package-details">
              ${renderReadyReviewTimeline(ctx)} ${renderReadyPublishEvidenceDetails(ctx)}
              <div class="rdy-draft-grid">
                <div class="rdy-publish-target-field">
                  <span>Publication target</span>
                  <div class="rdy-target-toggle" role="group" aria-label="Publication target">
                    <button
                      class="${ctx.publicationTarget === 'draft' ? 'active' : ''}"
                      @click=${() => ctx.setPublicationTarget('draft')}
                    >
                      Draft
                    </button>
                    <button
                      class="${ctx.publicationTarget === 'ready' ? 'active' : ''}"
                      @click=${() => ctx.setPublicationTarget('ready')}
                    >
                      Ready for review
                    </button>
                  </div>
                </div>
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

export function renderReadyPublishEvidenceDetails(
  ctx: Pick<ReadyPackagePanelContext, 'payload' | 'selectedEvidenceKeys' | 'publishEvidence'>,
) {
  if (!ctx.publishEvidence.length) return nothing;
  const rows = publishEvidenceDisplayRows(
    ctx.payload,
    ctx.selectedEvidenceKeys ?? ctx.payload.prPackage?.selectedEvidenceKeys,
    ctx.publishEvidence,
  );
  return html`
    <section class="rdy-review-card rdy-publish-evidence-card">
      <div class="rdy-review-card-head"><strong>Canonical publish evidence</strong></div>
      <div class="rdy-publish-evidence-list">
        ${rows.map(
          (row) => html`
            <div class="rdy-publish-evidence-row ${row.included ? 'included' : 'excluded'}">
              <span
                >${row.included
                  ? 'included'
                  : row.dropped
                    ? 'dropped after refresh'
                    : 'excluded'}</span
              >
              <code title=${row.path}>${row.label}</code>
              <small>${row.purpose}</small>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

export function renderReadyReviewTimeline(
  ctx: Pick<
    ReadyPackagePanelContext,
    'payload' | 'artifactUrl' | 'openReviewArtifact' | 'openReviewDiff'
  >,
) {
  const reviews = ctx.payload.independentReviews ?? [];
  return html`
    <div class="rdy-review-timeline">
      <review-loop-timeline
        .reviews=${reviews}
        compact
        .artifactUrl=${ctx.artifactUrl}
        @review-artifact-open=${(event: CustomEvent<ReviewLoopArtifactOpenDetail>) =>
          ctx.openReviewArtifact(event.detail)}
        @review-diff-open=${(event: CustomEvent<ReviewLoopArtifactOpenDetail>) =>
          ctx.openReviewDiff(event.detail)}
      ></review-loop-timeline>
      ${ctx.payload.selfReviewSummary
        ? html`
            <div class="rdy-review-card">
              <div class="rdy-review-card-head"><strong>Fix summary</strong></div>
              <div class="rdy-review-card-meta">${ctx.payload.selfReviewSummary}</div>
            </div>
          `
        : nothing}
    </div>
  `;
}

export function renderReadyResolvedBanner(input: {
  payload: ReadyGatePayload;
  resolvedAt?: string;
}) {
  if (!input.resolvedAt) return nothing;
  const shaShort = input.payload.headSha ? input.payload.headSha.slice(0, 7) : null;
  const message = shaShort
    ? `Decision resolved ${input.resolvedAt} at commit ${shaShort}. The diff below is the slot's current HEAD — it matches the reviewed snapshot only if the slot hasn't moved since.`
    : `Decision resolved ${input.resolvedAt}. The diff below is the slot's current HEAD — no snapshot SHA was captured for this gate, so it may differ from what was reviewed.`;
  return html`<div class="rdy-resolved-banner" role="status">${message}</div>`;
}
