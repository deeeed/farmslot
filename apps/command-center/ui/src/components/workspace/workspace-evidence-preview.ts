import { html, nothing, type TemplateResult } from 'lit';

import type {
  EvidenceReviewComparisonFilter,
  EvidenceReviewComparisonMedia,
  EvidenceReviewModel,
} from '@farmslot/adapter-sdk/evidence';
import {
  acceptanceVerdictLabel,
  type ArtifactRef,
  isRunArtifactImagePath,
  type SelfPrincipalSummary,
} from '@farmslot/protocol';

import '../shared/hydrating-placeholder.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { isPlainClick } from '../progress-tracker/acceptance-panel.js';
import { gatewayMediaSrc } from '../shared/gateway-media-src.js';

import { renderVisualClaimJudgment } from './visual-claim-judgment.js';
import {
  VIDEO_EXTS,
  workspaceArtifactBasename,
  workspaceArtifactTypeBadge,
} from './workspace-artifacts.js';

export interface WorkspaceEvidencePreviewItem {
  artifact: ArtifactRef;
  url: string;
  open?: () => void;
  openLabel?: string;
  selected?: boolean;
}

function evidenceArtifactLabel(artifact: ArtifactRef): string {
  const explicit = artifact.label?.trim();
  if (explicit) return explicit;
  const basename = workspaceArtifactBasename(artifact.path);
  const withoutFinalExtension = basename.replace(/\.(png|jpg|jpeg|gif|webp|mp4|mov|webm)$/i, '');
  const withoutTimestamp = withoutFinalExtension.replace(/-\d{10,}(?:\.\w+)?$/i, '');
  const withoutEmbeddedExtension = withoutTimestamp.replace(
    /\.(png|jpg|jpeg|gif|webp|mp4|mov|webm)$/i,
    '',
  );
  const withoutEvidencePrefix = withoutEmbeddedExtension.replace(/^evidence[-_]?/i, '');
  return withoutEvidencePrefix
    .replace(/[-_]+/g, ' ')
    .replace(/\bac(\d+)\b/gi, 'AC$1')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function dedupeWorkspaceEvidenceArtifacts(artifacts: readonly ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  const deduped: ArtifactRef[] = [];
  for (const artifact of artifacts) {
    // Collapse mirrored copies of the same media by content hash while preserving
    // semantic before/after pairs that happen to be byte-identical.
    const key = artifact.sha256
      ? `purpose:${artifact.purpose}:sha:${artifact.sha256}`
      : `path:${artifact.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(artifact);
  }
  return deduped;
}

export interface WorkspaceEvidenceComparison {
  model: EvidenceReviewModel;
  reviewer?: SelfPrincipalSummary | null;
  reviewing?: boolean;
  feedback?: import('@farmslot/review-dispatch').VisualJudgmentFeedback;
  reviewReason?(claimId: string): string;
  changeReviewReason?(claimId: string, reason: string): void;
  recordReview?(claimId: string, verdict: 'confirmed' | 'rejected'): void | Promise<void>;
  artifactUrl(path: string): string;
  openMedia(media: EvidenceReviewComparisonMedia, clipIndex?: number): void;
  openMoment(claimId: string, index: number): void;
  /** A criterion's proof file, opened in the host's evidence review instead of a new tab. */
  openProofFile?(claimId: string, artifactPath: string): void;
  changed(): void;
}

export function renderWorkspaceEvidencePreview(input: {
  comparison?: WorkspaceEvidenceComparison;
  title: string;
  subtitle?: string;
  hideHeader?: boolean;
  items: WorkspaceEvidencePreviewItem[];
  totalCount?: number;
  overflowHint?: string;
  compact?: boolean;
  empty?: TemplateResult | typeof nothing;
}): TemplateResult | typeof nothing {
  if (input.comparison) return renderComparisonPreview(input.comparison);
  if (input.items.length === 0) return input.empty ?? nothing;
  const totalCount = input.totalCount ?? input.items.length;
  const hiddenCount = Math.max(totalCount - input.items.length, 0);
  return html`
    <section
      class="ws-evidence-preview"
      style="margin-top:${spacing.md}; padding:${spacing.sm}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.md}; background:${colors.bgCard};"
    >
      <div
        style="display:flex; align-items:flex-start; justify-content:space-between; gap:${spacing.sm}; margin-bottom:${spacing.sm};"
      >
        <div style="display:flex; flex-direction:column; gap:2px; min-width:0;">
          ${!input.hideHeader
            ? html`<span
                style="font-size:${fonts.sizeXs}; text-transform:uppercase; letter-spacing:0.08em; color:${colors.textMuted}; font-weight:700;"
                >${input.title}</span
              >`
            : nothing}
          ${input.subtitle
            ? html`<span
                style="font-size:${fonts.sizeXs}; color:${colors.textSecondary}; line-height:1.45;"
                >${input.subtitle}</span
              >`
            : nothing}
        </div>
        <span
          style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; padding:2px 8px; border-radius:999px; border:1px solid ${colors.bgCardHover}; white-space:nowrap;"
          >${hiddenCount > 0 ? `${input.items.length} of ${totalCount}` : totalCount}
          artifact${totalCount === 1 ? '' : 's'}</span
        >
      </div>
      <div
        style="display:grid; grid-template-columns:repeat(auto-fit, minmax(${input.compact
          ? '160px'
          : '200px'}, 1fr)); gap:${spacing.sm};"
      >
        ${input.items.map(({ artifact, url, open, openLabel = 'Open in lightbox', selected }) => {
          const isImage = isRunArtifactImagePath(artifact.path);
          const isVideo = VIDEO_EXTS.test(artifact.path);
          const label = evidenceArtifactLabel(artifact);
          const clickable = Boolean(open) && !isVideo;
          return html`
            <div
              class="ws-evidence-card"
              data-testid=${`workspace-evidence-${artifact.path.replace(/^artifacts\//, '').replace(/[^a-zA-Z0-9_-]+/g, '-')}`}
              style="display:flex; flex-direction:column; gap:6px; text-align:left; border:1px solid ${selected
                ? colors.accent
                : colors.bgCardHover}; border-radius:${radii.md}; background:${selected
                ? `${colors.accent}16`
                : colors.bgSurface}; box-shadow:${selected
                ? `inset 0 0 0 1px ${colors.accent}22`
                : 'none'}; color:${colors.textPrimary}; padding:${spacing.xs}; cursor:${clickable
                ? 'pointer'
                : 'default'}; overflow:hidden;"
              role=${clickable ? 'button' : nothing}
              tabindex=${clickable ? '0' : nothing}
              @click=${() => {
                if (clickable) open?.();
              }}
              @keydown=${(event: KeyboardEvent) => {
                if (!clickable || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                open?.();
              }}
            >
              <div
                style="height:${input.compact
                  ? '116px'
                  : '150px'}; border-radius:${radii.sm}; overflow:hidden; background:${colors.bgBase}; border:1px solid ${colors.bgCardHover}; display:flex; align-items:center; justify-content:center;"
              >
                ${isImage
                  ? html`<img
                      src=${gatewayMediaSrc(url)}
                      alt=${label}
                      loading="lazy"
                      style="width:100%; height:100%; object-fit:contain; display:block;"
                    />`
                  : isVideo
                    ? html`<video
                        src=${gatewayMediaSrc(url)}
                        controls
                        muted
                        preload="metadata"
                        style="width:100%; height:100%; object-fit:contain; display:block;"
                      ></video>`
                    : html`<span style="font-size:${fonts.sizeXs}; color:${colors.textMuted};"
                        >${workspaceArtifactTypeBadge('other')}</span
                      >`}
              </div>
              ${isVideo && open
                ? html`<button
                    type="button"
                    style="border:1px solid ${colors.bgCardHover}; border-radius:${radii.sm}; background:${colors.bgCard}; color:${colors.accent}; font-size:${fonts.sizeXs}; font-family:${fonts.mono}; padding:4px 6px; cursor:pointer;"
                    @click=${() => open()}
                  >
                    ${openLabel}
                  </button>`
                : nothing}
              <span
                style="font-size:${fonts.sizeXs}; color:${colors.textPrimary}; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
                title=${label}
              >
                ${label}
              </span>
              <span
                style="font-family:${fonts.mono}; font-size:${fonts.sizeXs}; color:${colors.textMuted}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
                title=${artifact.path}
              >
                ${artifact.purpose} · ${artifact.path}
              </span>
            </div>
          `;
        })}
      </div>
      ${hiddenCount > 0
        ? html`<div
            style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-top:${spacing.xs};"
          >
            ${input.overflowHint ?? `+${hiddenCount} more artifact${hiddenCount === 1 ? '' : 's'}.`}
          </div>`
        : nothing}
    </section>
  `;
}

function renderComparisonPreview(input: WorkspaceEvidenceComparison): TemplateResult {
  const { model } = input;
  const filters: readonly EvidenceReviewComparisonFilter[] = [
    'all',
    'before',
    'after',
    'review',
    'screenshots',
    'moments',
    'unassigned',
  ];
  const view = model.comparisonView;
  const rawArtifacts = model.rawArtifacts(model.artifactInventory);
  const transform = model.comparisonTransform;
  const updateTransform = (scale: number, x = transform.x, y = transform.y) => {
    model.setComparisonTransform({ scale, x, y });
    input.changed();
  };
  const card = (media: EvidenceReviewComparisonMedia) =>
    html` <div class="ws-ac-media" style="min-width:0;">
      <button
        type="button"
        @click=${() => input.openMedia(media)}
        style="width:100%;height:230px;background:${colors.bgBase};border:1px solid ${colors.bgCardHover};overflow:hidden;cursor:zoom-in;"
        aria-label=${`Open ${media.name}`}
        @wheel=${(event: WheelEvent) => {
          event.preventDefault();
          updateTransform(transform.scale + (event.deltaY < 0 ? 0.25 : -0.25));
        }}
        @pointermove=${(event: PointerEvent) => {
          if (event.buttons !== 1) return;
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          updateTransform(
            transform.scale,
            (event.clientX - rect.left) / rect.width,
            (event.clientY - rect.top) / rect.height,
          );
        }}
      >
        ${media.mediaType === 'image'
          ? html`<img
              src=${gatewayMediaSrc(input.artifactUrl(media.artifactPath))}
              alt=${media.name}
              loading="lazy"
              style=${`width:100%;height:100%;object-fit:contain;transform:scale(${transform.scale});transform-origin:${transform.x * 100}% ${transform.y * 100}%;`}
            />`
          : html`<span>Open video fullscreen</span>`}
      </button>
      <div style="color:${colors.textMuted};font-size:11px;overflow-wrap:anywhere;">
        ${media.capture?.role ?? 'Unassigned'} ·
        ${media.capture?.sourceCommit?.slice(0, 8) ?? 'source unknown'} · ${media.originalPath}
      </div>
      ${media.limitation
        ? html`<div style="color:${colors.textSecondary};font-size:11px;">${media.limitation}</div>`
        : nothing}
      ${media.clips.map(
        (clip, index) =>
          html`<button
            type="button"
            @click=${() => input.openMedia(media, index)}
            aria-label=${`Video moment for ${media.name}`}
          >
            Video ${formatMoment(clip.momentMs ?? clip.startMs)}
          </button>`,
      )}
    </div>`;
  const side = (row: EvidenceReviewModel['comparisons'][number], role: 'before' | 'after') => {
    const candidates = row[role];
    const selected = role === 'before' ? row.selectedBefore : row.selectedAfter;
    const visibleSelected =
      selected && candidates.some((entry) => entry.identity === selected.identity)
        ? selected
        : undefined;
    return html`<div style="min-width:0;">
      <strong>${role === 'before' ? 'Before' : 'After'}</strong>
      ${candidates.length > 1
        ? html`<select
            aria-label=${`Select ${role} for ${row.claim.id}`}
            @change=${(event: Event) => {
              model.chooseComparisonMedia(
                row.claim.id,
                role,
                (event.currentTarget as HTMLSelectElement).value,
              );
              input.changed();
            }}
            .value=${selected?.identity ?? ''}
          >
            <option value="">Choose a capture</option>
            ${candidates.map(
              (media) =>
                html`<option value=${media.identity} ?disabled=${!media.eligible}>
                  ${media.name}${media.limitation ? ` (${media.limitation})` : ''}
                </option>`,
            )}
          </select>`
        : nothing}
      ${visibleSelected
        ? card(visibleSelected)
        : html`<div
            style="padding:24px;color:${colors.textMuted};border:1px dashed ${colors.bgCardHover};"
          >
            ${candidates.length > 1
              ? 'Choose a capture to compare'
              : `No qualified ${role} capture`}
          </div>`}
      ${candidates.some((media) => !media.eligible)
        ? html`<details>
            <summary>Recorded ${role} media unavailable for comparison</summary>
            ${candidates.filter((media) => !media.eligible).map(card)}
          </details>`
        : nothing}
    </div>`;
  };
  return html`<section
    class="ws-compare-by-ac"
    data-testid="compare-by-ac"
    style="display:flex;flex-direction:column;gap:16px;"
  >
    <style>
      .ws-compare-by-ac button,
      .ws-compare-by-ac select,
      .ws-compare-by-ac textarea {
        border: 1px solid ${colors.bgCardHover};
        background: ${colors.bgSurface};
        color: ${colors.textSecondary};
        border-radius: 4px;
        padding: 5px 8px;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .ws-compare-by-ac button[aria-pressed='true'] {
        color: ${colors.accent};
        border-color: ${colors.accent};
        background: ${colors.accent}18;
      }
      .ws-compare-by-ac a {
        color: ${colors.accent};
        font-size: 12px;
        white-space: nowrap;
      }
    </style>
    ${model.gateSnapshot
      ? html`<div
          style="padding:10px;border:1px solid ${colors.bgCardHover};border-radius:6px;background:${colors.bgCard};font-size:12px;"
        >
          <div>Review head <code>${model.gateSnapshot.headSha ?? 'not captured'}</code></div>
          <div>${model.gateSnapshot.reviewRequirement.label}</div>
          <div>Own review: ${model.gateSnapshot.ownReviewVerdict ?? 'not captured'}</div>
          ${model.gateSnapshot.reviews.map(
            (review) =>
              html`<div>
                Review history: ${review.mode} · ${review.verdict}${review.stale ? ' · stale' : ''}
                · head
                <code
                  >${review.reviewedHeadSha ??
                  review.reviewSnapshot?.headSha ??
                  'not captured'}</code
                >
              </div>`,
          )}
          <div>
            CI parity
            ${model.gateSnapshot.ci.length
              ? model.gateSnapshot.ci
                  .map((check) => `${check.reference}: ${check.status}`)
                  .join('; ')
              : 'not captured for this head'}
          </div>
          ${model.gateSnapshot.requirements.length
            ? html`<details>
                <summary>Open requirements (${model.gateSnapshot.requirements.length})</summary>
                ${model.gateSnapshot.requirements.map((reason) => html`<p>${reason.message}</p>`)}
              </details>`
            : nothing}
          <strong>Next action: ${model.gateSnapshot.nextAction}</strong>
        </div>`
      : nothing}
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <strong>Compare by AC</strong>
      ${filters.map(
        (filter) =>
          html`<button
            type="button"
            data-comparison-filter=${filter}
            aria-pressed=${model.comparisonFilter === filter}
            @click=${() => {
              model.setComparisonFilter(filter);
              input.changed();
            }}
          >
            ${filter === 'moments'
              ? 'Video moments'
              : filter === 'unassigned'
                ? `Unassigned (${model.unassigned.length})`
                : filter[0]!.toUpperCase() + filter.slice(1)}
          </button>`,
      )}
      <button
        type="button"
        @click=${() => updateTransform(transform.scale - 0.25)}
        aria-label="Zoom out"
      >
        −</button
      ><span>${Math.round(transform.scale * 100)}%</span>
      <button
        type="button"
        @click=${() => updateTransform(transform.scale + 0.25)}
        aria-label="Zoom in"
      >
        +
      </button>
      <button
        type="button"
        @click=${() => {
          model.resetComparisonTransform();
          input.changed();
        }}
      >
        Reset zoom
      </button>
    </div>
    ${model.packageStatus
      ? html`<div>
          ${model.packageStatus.status} · ${model.packageStatus.path} ·
          ${model.packageStatus.summary}
        </div>`
      : nothing}
    ${model.comparisonErrors.map(
      (issue) =>
        html`<p style="color:${colors.statusFail};">
          ${issue.code}: ${issue.artifactPath} · ${issue.message}. Refresh the gate package or
          select another capture.
        </p>`,
    )}
    ${view.rows.map(
      (row) =>
        html`<article
          data-ac=${row.claim.id}
          style="border:1px solid ${colors.bgCardHover};border-radius:${radii.md};padding:12px;background:${colors.bgCard};"
        >
          <div style="display:flex;justify-content:space-between;gap:12px;">
            <strong>${row.claim.id}: ${row.claim.text}</strong> ${row.sourceUrl
              ? html`<a href=${row.sourceUrl} target="_blank" rel="noopener">Original Jira AC</a>`
              : nothing}
          </div>
          <div style="margin:8px 0;color:${colors.textSecondary};">
            ${row.claim.status ? acceptanceVerdictLabel(row.claim.status) : 'not assessed'} ·
            ${row.claim.status?.proofMode ?? 'no proof mode'} ·
            ${row.claim.proofKinds.join(', ') || 'no recorded proof'}
            ${row.claim.reviewLabels.join('; ')}
          </div>
          ${row.primaryFiles.map(
            (file) =>
              html`<div>
                <a
                  data-selected-proof-file
                  href=${gatewayMediaSrc(input.artifactUrl(file.artifactPath))}
                  target="_blank"
                  rel="noopener"
                  @click=${(event: MouseEvent) => {
                    if (!input.openProofFile || !isPlainClick(event)) return;
                    event.preventDefault();
                    input.openProofFile(row.claim.id, file.artifactPath);
                  }}
                >
                  Selected file · ${file.name}
                </a>
              </div>`,
          )}
          <div
            style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:12px;"
          >
            ${side(row, 'before')}${side(row, 'after')}
          </div>
          ${!row.selectedBefore && !row.selectedAfter && row.claim.clips[0]
            ? html`<div style="margin-top:12px;">
                <strong>AC proof · recorded moment</strong
                ><button
                  style="display:block;width:100%;height:210px;margin-top:8px;background:${colors.bgBase};"
                  @click=${() => input.openMoment(row.claim.id, 0)}
                  aria-label=${`Open fullscreen proof for ${row.claim.id}`}
                >
                  <video
                    src=${gatewayMediaSrc(
                      input.artifactUrl(model.artifactPath(row.claim.clips[0]!.videoPath)),
                    )}
                    muted
                    preload="metadata"
                    style="width:100%;height:100%;object-fit:contain;"
                    @loadedmetadata=${(event: Event) => {
                      const video = event.currentTarget as HTMLVideoElement;
                      const clip = row.claim.clips[0]!;
                      video.currentTime = (clip.momentMs ?? clip.startMs) / 1000;
                    }}
                  ></video>
                </button>
              </div>`
            : nothing}
          ${row.review.length
            ? html`<details>
                <summary>Review media (${row.review.length})</summary>
                <div
                  style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;"
                >
                  ${row.review.map(card)}
                </div>
              </details>`
            : nothing}
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
            ${(row.primaryClip ? [row.primaryClip] : []).map(
              (clip, index) =>
                html`<button
                  type="button"
                  data-video-claim=${row.claim.id}
                  data-video-moment=${index}
                  @click=${() => input.openMoment(row.claim.id, index)}
                >
                  Video ${formatMoment(clip.momentMs ?? clip.startMs)} · ${clip.caption}
                </button>`,
            )}
          </div>
          ${!row.claim.clips.length && !row.before.length && !row.after.length && !row.review.length
            ? html`<p style="color:${colors.textMuted};font-size:12px;">
                No AC-bound capture. Retained unbound media is in Unassigned.
              </p>`
            : nothing}
          ${(() => {
            const judgment = model
              .judgmentRows(input.reviewer ?? null)
              .find((entry) => entry.claim.id === row.claim.id);
            return judgment
              ? renderVisualClaimJudgment({
                  row: judgment,
                  busy: input.reviewing || !input.recordReview,
                  feedback: input.feedback,
                  reason: input.reviewReason?.(row.claim.id) ?? '',
                  changeReason: (reason) => input.changeReviewReason?.(row.claim.id, reason),
                  record: (verdict) => {
                    void input.recordReview?.(row.claim.id, verdict);
                  },
                })
              : nothing;
          })()}
        </article>`,
    )}
    ${model.comparisonFilter === 'all' && rawArtifacts.length
      ? html`<details data-testid="comparison-raw-artifacts">
          <summary>raw artifacts (${rawArtifacts.length})</summary>
          ${rawArtifacts.map(
            (artifact) =>
              html`<div>
                <a
                  href=${gatewayMediaSrc(input.artifactUrl(artifact.path))}
                  target="_blank"
                  rel="noopener"
                >
                  ${artifact.path}
                </a>
              </div>`,
          )}
        </details>`
      : nothing}
    ${model.comparisonFilter !== 'all' && view.unassigned.length
      ? html`<details open=${model.comparisonFilter === 'unassigned' || nothing}>
          <summary>Unassigned (${view.unassigned.length})</summary>
          <p>These files have no recorded AC and role binding.</p>
          <div
            style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;"
          >
            ${view.unassigned.map(card)}
          </div>
        </details>`
      : nothing}
  </section>`;
}

function formatMoment(ms: number): string {
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
}

export function renderEvidenceGridSkeleton(error = '', retry?: () => void, count = 4) {
  return html`<farm-hydrating message="Evidence" .error=${error} @retry=${retry}
    ><div style="display:grid;gap:12px;min-height:340px">
      <farm-skeleton width="30%"></farm-skeleton>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
        ${Array.from(
          { length: count },
          () =>
            html`<div style="display:grid;gap:12px">
              <farm-skeleton kind="block" height="150"></farm-skeleton
              ><farm-skeleton width="65%"></farm-skeleton>
            </div>`,
        )}
      </div>
    </div></farm-hydrating
  >`;
}
