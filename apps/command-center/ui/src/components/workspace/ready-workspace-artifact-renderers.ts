import { html, nothing, type TemplateResult } from 'lit';

import type { ArtifactRef, RecipeRunArtifactGroup } from '@farmslot/protocol';

import { buildBeforeAfterPairs } from '../../utils/artifact-pairs.js';
import { formatBytes } from '../../utils/format.js';
import { renderCollapsibleSectionHeader } from '../shared/collapsible-section-header.js';

import {
  type ArtifactFilter,
  type ArtifactGroup,
  type ArtifactTypeFilter,
  IMAGE_EXTS,
  isWorkspaceDiffArtifact,
  MEDIA_EXTS,
  VIDEO_EXTS,
  workspaceArtifactBasename,
  workspaceArtifactGroup,
  workspaceArtifactGroupLabel,
  workspaceArtifactType,
  workspaceArtifactTypeBadge,
  workspaceArtifactTypeLabel,
} from './workspace-artifacts.js';
import {
  dedupeWorkspaceEvidenceArtifacts,
  renderWorkspaceEvidencePreview,
} from './workspace-evidence-preview.js';

export interface ReadySelectedRecipeRunArtifactsContext {
  group: RecipeRunArtifactGroup | null;
  artifacts: ArtifactRef[];
  evidenceCollapsed: boolean;
  toggleEvidenceCollapsed: () => void;
  openCompare: (group: RecipeRunArtifactGroup, artifacts: ArtifactRef[]) => void;
  artifactUrl: (group: RecipeRunArtifactGroup, artifact: ArtifactRef) => string;
  openArtifact: (
    group: RecipeRunArtifactGroup,
    artifact: ArtifactRef,
    scopedArtifacts: ArtifactRef[],
  ) => void;
}

export function renderReadySelectedRecipeRunArtifacts(ctx: ReadySelectedRecipeRunArtifactsContext) {
  if (!ctx.group || ctx.artifacts.length === 0) return nothing;
  const group = ctx.group;
  const displayArtifacts = dedupeWorkspaceEvidenceArtifacts(ctx.artifacts);
  const previewArtifacts = displayArtifacts.slice(0, 12);
  const hiddenCount = displayArtifacts.length - previewArtifacts.length;
  const pairCount = buildBeforeAfterPairs(displayArtifacts).length;
  const sectionLabel = `${group.label} evidence`;
  return html`
    <section class="rdy-quality-card rdy-package-evidence-section">
      ${renderCollapsibleSectionHeader(sectionLabel, ctx.evidenceCollapsed, ctx.toggleEvidenceCollapsed)}
      ${ctx.evidenceCollapsed
        ? html`<div class="rdy-review-card-meta rdy-package-evidence-collapsed-hint">
            ${displayArtifacts.length} artifact${displayArtifacts.length === 1 ? '' : 's'} hidden —
            expand to preview screenshots${pairCount
              ? html` or compare ${pairCount} before/after pair${pairCount === 1 ? '' : 's'}`
              : nothing}.
          </div>`
        : html`
            <div class="rdy-artifact-toolbar">
              <span class="rdy-review-card-meta">
                ${group.groupKind === 'live-run'
                  ? 'Latest live run output'
                  : group.groupKind === 'latest-valid'
                    ? 'Latest passing evidence'
                    : 'Current package artifacts'}
              </span>
              ${pairCount
                ? html`
                    <button
                      class="rdy-artifact-filter compare"
                      @click=${() => ctx.openCompare(group, displayArtifacts)}
                    >
                      Compare ${pairCount} before/after
                    </button>
                  `
                : nothing}
            </div>
            ${renderWorkspaceEvidencePreview({
              title: sectionLabel,
              hideHeader: true,
              subtitle: 'Local screenshot/video artifacts exactly as the gate will use them.',
              totalCount: displayArtifacts.length,
              overflowHint: `+${hiddenCount} more artifact${
                hiddenCount === 1 ? '' : 's'
              } in the full artifact grid below.`,
              items: previewArtifacts.map((artifact) => ({
                artifact,
                url: ctx.artifactUrl(group, artifact),
                open: () => ctx.openArtifact(group, artifact, displayArtifacts),
              })),
            })}
          `}
    </section>
  `;
}

export interface ReadyArtifactGroupsContext {
  artifacts: ArtifactRef[];
  artifactFilter: ArtifactFilter;
  artifactTypeFilter: ArtifactTypeFilter;
  hideFilter?: boolean;
  publishSelectable?: boolean;
  setArtifactFilter: (filter: ArtifactFilter) => void;
  setArtifactTypeFilter: (filter: ArtifactTypeFilter) => void;
  openCompare: () => void;
  renderArtifactCard: (
    artifact: ArtifactRef,
    options: { publishSelectable?: boolean },
  ) => TemplateResult;
}

export function renderReadyArtifactGroups(ctx: ReadyArtifactGroupsContext) {
  const counts: Record<ArtifactGroup, number> = { before: 0, after: 0, review: 0, other: 0 };
  for (const artifact of ctx.artifacts) counts[workspaceArtifactGroup(artifact)] += 1;
  const activeFilter = ctx.hideFilter ? 'all' : ctx.artifactFilter;
  const groupFiltered =
    activeFilter === 'all'
      ? ctx.artifacts
      : ctx.artifacts.filter((artifact) => workspaceArtifactGroup(artifact) === activeFilter);
  const typeCounts: Record<ArtifactTypeFilter, number> = {
    all: ctx.artifacts.length,
    image: 0,
    video: 0,
    markdown: 0,
    json: 0,
    diff: 0,
    other: 0,
  };
  for (const artifact of ctx.artifacts) typeCounts[workspaceArtifactType(artifact)] += 1;
  const activeTypeFilter = ctx.hideFilter ? 'all' : ctx.artifactTypeFilter;
  const filtered =
    activeTypeFilter === 'all'
      ? groupFiltered
      : groupFiltered.filter((artifact) => workspaceArtifactType(artifact) === activeTypeFilter);
  const groups: ArtifactGroup[] = ['before', 'after', 'review', 'other'];
  const pairCount = buildBeforeAfterPairs(
    ctx.artifacts.filter((artifact) => MEDIA_EXTS.test(artifact.path)),
  ).length;
  const filters: Array<{ value: ArtifactFilter; label: string; count: number }> = [
    { value: 'all', label: 'All', count: ctx.artifacts.length },
    { value: 'before', label: 'Before', count: counts.before },
    { value: 'after', label: 'After', count: counts.after },
    { value: 'review', label: 'Review', count: counts.review },
    { value: 'other', label: 'Other', count: counts.other },
  ];
  const typeFilters: Array<{ value: ArtifactTypeFilter; count: number }> = [
    { value: 'all', count: typeCounts.all },
    { value: 'image', count: typeCounts.image },
    { value: 'video', count: typeCounts.video },
    { value: 'markdown', count: typeCounts.markdown },
    { value: 'json', count: typeCounts.json },
    { value: 'diff', count: typeCounts.diff },
    { value: 'other', count: typeCounts.other },
  ];

  return html`
    <div class="rdy-artifact-groups">
      ${ctx.hideFilter
        ? nothing
        : html`
            <div class="rdy-artifact-toolbar">
              <div class="rdy-artifact-filter-stack">
                <div class="rdy-artifact-filters" aria-label="Artifact stage filters">
                  ${filters.map(
                    (filter) => html`
                      <button
                        class="rdy-artifact-filter ${ctx.artifactFilter === filter.value
                          ? 'active'
                          : ''}"
                        ?disabled=${filter.count === 0}
                        @click=${() => ctx.setArtifactFilter(filter.value)}
                      >
                        ${filter.label} <span>${filter.count}</span>
                      </button>
                    `,
                  )}
                </div>
                <div class="rdy-artifact-filters" aria-label="Artifact type filters">
                  ${typeFilters.map(
                    (filter) => html`
                      <button
                        class="rdy-artifact-filter ${ctx.artifactTypeFilter === filter.value
                          ? 'active'
                          : ''}"
                        ?disabled=${filter.count === 0}
                        @click=${() => ctx.setArtifactTypeFilter(filter.value)}
                      >
                        ${workspaceArtifactTypeLabel(filter.value)} <span>${filter.count}</span>
                      </button>
                    `,
                  )}
                </div>
              </div>
              ${pairCount
                ? html`
                    <button class="rdy-artifact-filter compare" @click=${ctx.openCompare}>
                      Compare ${pairCount} before/after
                    </button>
                  `
                : nothing}
            </div>
          `}
      ${groups.map((group) => {
        const groupArtifacts = filtered.filter(
          (artifact) => workspaceArtifactGroup(artifact) === group,
        );
        if (!groupArtifacts.length) return nothing;
        return html`
          <section class="rdy-artifact-group">
            <div class="rdy-artifact-group-title">
              <span>${workspaceArtifactGroupLabel(group)}</span>
              <span>${groupArtifacts.length}</span>
            </div>
            <div class="rdy-artifacts-grid">
              ${groupArtifacts.map((artifact) =>
                ctx.renderArtifactCard(artifact, {
                  publishSelectable: ctx.publishSelectable,
                }),
              )}
            </div>
          </section>
        `;
      })}
      ${filtered.length === 0
        ? html`<div class="rdy-tab-empty">No artifacts match this filter.</div>`
        : nothing}
    </div>
  `;
}

export interface ReadyArtifactCardContext {
  artifact: ArtifactRef;
  compact?: boolean;
  selectable: boolean;
  selected: boolean;
  opensInLightbox: boolean;
  mediaUrl: string | null;
  open: () => void;
  setIncluded: (included: boolean) => void;
}

export function renderReadyArtifactCard(ctx: ReadyArtifactCardContext) {
  const artifact = ctx.artifact;
  const isImage = IMAGE_EXTS.test(artifact.path);
  const isVideo = VIDEO_EXTS.test(artifact.path);
  const isDiff = isWorkspaceDiffArtifact(artifact);
  const isMedia = isImage || isVideo;
  const clickable = ctx.opensInLightbox || isDiff;
  const size = artifact.sizeBytes ? formatBytes(artifact.sizeBytes) : '';
  const artifactType = workspaceArtifactType(artifact);
  const open = () => {
    if (clickable) ctx.open();
  };
  return html`
    <div
      class=${`rdy-artifact-card ${isMedia ? 'rdy-media-card' : ''} ${clickable ? 'clickable' : ''} ${ctx.compact ? 'compact' : ''} ${ctx.selectable && !ctx.selected ? 'excluded' : ''}`}
      role=${clickable ? 'button' : 'listitem'}
      tabindex=${clickable ? '0' : '-1'}
      title=${clickable ? `Open ${artifact.path}` : artifact.path}
      @click=${open}
      @keydown=${(event: KeyboardEvent) => {
        if (!clickable || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        open();
      }}
    >
      <span class=${`rdy-artifact-type-badge ${artifactType}`}
        >${workspaceArtifactTypeBadge(artifactType)}</span
      >
      ${ctx.selectable
        ? html`
            <label class="rdy-artifact-select" @click=${(event: Event) => event.stopPropagation()}>
              <input
                type="checkbox"
                .checked=${ctx.selected}
                @change=${(event: Event) =>
                  ctx.setIncluded((event.target as HTMLInputElement).checked)}
              />
              Include in PR
            </label>
          `
        : nothing}
      ${isImage && ctx.mediaUrl
        ? html`
            <img
              class="rdy-media-preview"
              src=${ctx.mediaUrl}
              alt=${artifact.path}
              loading="lazy"
            />
          `
        : isVideo && ctx.mediaUrl
          ? html`
              <video
                class="rdy-media-preview"
                src=${ctx.mediaUrl}
                controls
                muted
                preload="metadata"
              ></video>
            `
          : nothing}
      <div class="rdy-artifact-name" title=${artifact.path}>
        <span class="rdy-artifact-purpose">${artifact.purpose}</span>
        ${workspaceArtifactBasename(artifact.path)}
        ${size ? html`<span class="rdy-artifact-size">${size}</span>` : nothing}
      </div>
      ${!isImage && !isVideo
        ? html`<div class="rdy-artifact-type">
            ${artifact.path.split('.').pop()?.toUpperCase()}
          </div>`
        : nothing}
    </div>
  `;
}
