import { html, nothing } from 'lit';

import type { ArtifactRef, PublicationTarget, ReadyGatePayload } from '@farmslot/protocol';

import '../reviews/gate-summary-panel.js';

import {
  publishEvidenceDisplayRows,
  summarizeReviewCounts,
} from '../../utils/review-gate-display.js';

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
  openReviewFlow: () => void;
  toggleExpanded: () => void;
  refreshPackage: () => void | Promise<void>;
  setPublicationTarget: (target: PublicationTarget) => void;
}

export function renderReadyPackagePanel(ctx: ReadyPackagePanelContext) {
  const reviewSummary = summarizeReviewCounts(ctx.payload);
  const selectedEvidenceCount = ctx.publishEvidence.filter((artifact) =>
    ctx.selectedEvidence.has(artifact.path),
  ).length;
  const reviewReady =
    reviewSummary.trustedPassingReviews >= reviewSummary.requiredReviews &&
    reviewSummary.unresolvedFindings === 0;
  const reviewStatus = reviewReady
    ? 'Review requirement satisfied'
    : reviewSummary.unresolvedFindings > 0
      ? `${reviewSummary.unresolvedFindings} finding${reviewSummary.unresolvedFindings === 1 ? '' : 's'} require resolution`
      : `${Math.max(0, reviewSummary.requiredReviews - reviewSummary.trustedPassingReviews)} passing review${reviewSummary.requiredReviews - reviewSummary.trustedPassingReviews === 1 ? '' : 's'} still required`;
  return html`
    <div class="rdy-package-panel">
      ${ctx.payload.gateSummary
        ? html`<gate-summary-panel .summary=${ctx.payload.gateSummary}></gate-summary-panel>`
        : nothing}
      <div class="rdy-package-summary">
        <div class="rdy-package-header">
          <div class="rdy-package-title">
            <strong>Pre-publication cockpit</strong>
            ${ctx.packageArtifact && ctx.payload.prPackage
              ? html`
                  <button
                    class="rdy-cockpit-link"
                    title="Open PR package markdown"
                    @click=${() => ctx.openPackageArtifact(ctx.packageArtifact!)}
                  >
                    ${ctx.payload.prPackage.id} · ${ctx.payload.prPackage.packageHash.slice(0, 12)}
                  </button>
                `
              : html`<span
                  >${ctx.payload.prPackage?.id ?? 'Package unavailable'} ·
                  ${ctx.payload.prPackage?.packageHash?.slice(0, 12) ?? 'no hash'}</span
                >`}
          </div>
          <div class="rdy-package-actions">
            <button class="rdy-review-flow-button" @click=${ctx.openReviewFlow}>
              Review flow
              <span
                >${reviewSummary.totalAttempts}
                attempt${reviewSummary.totalAttempts === 1 ? '' : 's'}</span
              >
            </button>
            <button class="rdy-cockpit-link" @click=${ctx.toggleExpanded}>
              ${ctx.expanded ? 'Hide package details' : 'Package details'}
            </button>
            ${ctx.resolved
              ? nothing
              : html`
                  <button
                    class="rdy-refresh-package"
                    ?disabled=${ctx.refreshingPackage || ctx.acting || ctx.recovering}
                    title="Rebuild the publication package from the current HEAD, diff, evidence, and PR body"
                    @click=${ctx.refreshPackage}
                  >
                    ${ctx.refreshingPackage ? 'Refreshing…' : 'Refresh current package'}
                  </button>
                `}
          </div>
        </div>
        <div class="rdy-package-status ${reviewReady ? 'ready' : 'attention'}">
          <strong>${reviewStatus}</strong>
          <span
            >${reviewSummary.trustedPassingReviews}/${reviewSummary.requiredReviews} passing ·
            ${reviewSummary.totalAttempts}
            attempt${reviewSummary.totalAttempts === 1 ? '' : 's'}</span
          >
        </div>
        <div class="rdy-package-facts">
          ${reviewSummary.fixLoopCertified ? html`<span>Full-live fix loop</span>` : nothing}
          ${reviewSummary.staleIgnoredReviews
            ? html`<span>${reviewSummary.staleIgnoredReviews} stale ignored</span>`
            : nothing}
          ${reviewSummary.externalRequired
            ? html`<span
                >Runner diversity
                ${reviewSummary.externalFreshPassingReviews ? 'present' : 'required'}</span
              >`
            : nothing}
          ${ctx.publishEvidence.length
            ? html`<span>Evidence ${selectedEvidenceCount}/${ctx.publishEvidence.length}</span>`
            : nothing}
        </div>
      </div>
      ${ctx.expanded
        ? html`
            <div class="rdy-package-details">
              ${renderReadyPublishEvidenceDetails(ctx)}
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
