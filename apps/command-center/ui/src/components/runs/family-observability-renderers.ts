import { html, nothing, type TemplateResult } from 'lit';

import {
  type FamilyObservabilityArtifact,
  type FamilyObservabilityRunSummary,
  type FamilyObservabilitySnapshot,
  githubPullUrl,
  isRunEvidenceVideoArtifact,
  parseGitHubRef,
  type PRStatus,
  type RelatedRunSummary,
} from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';
import { MARKDOWN_EXTS } from '../../utils/artifact-file-types.js';

import {
  type EvidenceGroup,
  MAX_ARTIFACTS_PER_EVIDENCE_GROUP,
} from './family-observability-evidence.js';
import { flowColor, flowLabel, formatCreatedAt, runStatusColor } from './run-utils.js';

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif)$/i;

export type FamilyEvidenceFilter = 'all' | 'before' | 'after' | 'setup' | 'videos';

export interface FamilyEvidenceRenderContext {
  evidenceFilter: FamilyEvidenceFilter;
  evidenceGroups(snapshot: FamilyObservabilitySnapshot): EvidenceGroup[];
  visibleEvidenceArtifacts: FamilyObservabilityArtifact[];
  artifactKind(artifact: FamilyObservabilityArtifact): 'before' | 'after' | 'setup';
  setEvidenceFilter(filter: FamilyEvidenceFilter): void;
  artifactUrl(artifact: FamilyObservabilityArtifact): string;
  artifactCaption(artifact: FamilyObservabilityArtifact): string;
  isBrokenArtifact(artifact: FamilyObservabilityArtifact): boolean;
  markArtifactBroken(artifact: FamilyObservabilityArtifact): void;
  pairForArtifact(artifact: FamilyObservabilityArtifact): { index: number } | null;
  openArtifact(artifact: FamilyObservabilityArtifact, event: Event): void;
  openCompare(pairIndex: number, event: Event): void;
  runBadgeLabel(
    run: Pick<FamilyObservabilityRunSummary, 'flowType' | 'lane' | 'ticketOrPr'>,
  ): string;
  renderMarkdownPreview(artifact: FamilyObservabilityArtifact, url: string): TemplateResult;
}

const FILTER_CHIPS: { label: string; value: FamilyEvidenceFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Before', value: 'before' },
  { label: 'After', value: 'after' },
  { label: 'Setup', value: 'setup' },
  { label: 'Videos', value: 'videos' },
];

function evidenceFilterTitle(filter: FamilyEvidenceFilter): string {
  if (filter === 'before') return 'Baseline captures from main';
  if (filter === 'after') return 'Captures from the fix branch';
  if (filter === 'setup') return 'Orientation/setup shots';
  if (filter === 'videos') return 'Recipe videos and screen recordings';
  return 'Show all evidence';
}

function evidenceArtifactMatchesFilter(
  artifact: FamilyObservabilityArtifact,
  filter: Exclude<FamilyEvidenceFilter, 'all'>,
  context: Pick<FamilyEvidenceRenderContext, 'artifactKind'>,
): boolean {
  if (filter === 'videos') return isRunEvidenceVideoArtifact(artifact);
  return context.artifactKind(artifact) === filter;
}

export function renderFamilyEvidence(
  snapshot: FamilyObservabilitySnapshot,
  context: FamilyEvidenceRenderContext,
): TemplateResult {
  if (snapshot.evidence.length === 0) {
    return html`<div class="muted">No evidence artifacts available.</div>`;
  }
  const allGroups = context.evidenceGroups(snapshot);
  const filter = context.evidenceFilter;
  const groups =
    filter === 'all'
      ? allGroups
      : allGroups
          .map((group) => ({
            ...group,
            artifacts: group.artifacts.filter((artifact) =>
              evidenceArtifactMatchesFilter(artifact, filter, context),
            ),
          }))
          .filter((group) => group.artifacts.length > 0);
  const hiddenGroupCount =
    filter === 'all'
      ? Math.max(0, snapshot.evidence.length - context.visibleEvidenceArtifacts.length)
      : 0;
  const compareCards = familyEvidenceCompareCards(groups, context);
  return html`
    <div class="evidence-provenance-note">
      Evidence is grouped by producing run and capture batch. Before/after pairs open in the shared
      side-by-side viewer; raw artifact groups stay collapsed to keep the family page scannable.
    </div>
    <div class="evidence-filter-row">
      ${FILTER_CHIPS.map(
        (chip) => html`
          <button
            class="evidence-filter-chip ${filter === chip.value ? 'active' : ''}"
            @click=${() => context.setEvidenceFilter(chip.value)}
            title=${evidenceFilterTitle(chip.value)}
          >
            ${chip.label}
          </button>
        `,
      )}
    </div>
    ${compareCards.length > 0
      ? html`
          <div class="evidence-compare-strip">
            <div class="evidence-compare-head">
              <strong>Before/after comparisons</strong>
              <span>${compareCards.length} pair${compareCards.length === 1 ? '' : 's'}</span>
            </div>
            <div class="evidence-compare-grid">
              ${compareCards.slice(0, 8).map(
                ({ artifact, group, index }) => html`
                  <button
                    class="evidence-compare-card"
                    @click=${(event: Event) => context.openCompare(index, event)}
                  >
                    <span>Compare</span>
                    <strong>${artifact.path.split('/').pop() ?? artifact.path}</strong>
                    <small>${group.title} · run ${artifact.runId.slice(0, 8)}</small>
                  </button>
                `,
              )}
            </div>
            ${compareCards.length > 8
              ? html`<div class="evidence-group-more">+${compareCards.length - 8} more pairs</div>`
              : nothing}
          </div>
        `
      : nothing}
    <details class="evidence-raw-details">
      <summary>Show raw artifact groups</summary>
      <div class="evidence-groups">
        ${groups.length === 0
          ? html`<div class="muted">No artifacts match the current filter.</div>`
          : nothing}
        ${groups.map((group) => {
          const visibleArtifacts = group.artifacts.slice(0, MAX_ARTIFACTS_PER_EVIDENCE_GROUP);
          const hiddenArtifacts = group.artifacts.length - visibleArtifacts.length;
          return html`
            <div class="evidence-group ${group.capturedBeforeRun ? 'carried' : ''}">
              <div class="evidence-group-header">
                <div>
                  <div class="evidence-group-title">${group.title}</div>
                  <div class="evidence-group-meta">${group.subtitle}</div>
                </div>
                <span class="evidence-group-count">${group.artifacts.length}</span>
              </div>
              <div class="evidence-grid">
                ${visibleArtifacts.map((artifact) =>
                  renderFamilyEvidenceArtifact(artifact, group, context),
                )}
              </div>
              ${hiddenArtifacts > 0
                ? html`<div class="evidence-group-more">
                    +${hiddenArtifacts} more in this batch
                  </div>`
                : nothing}
            </div>
          `;
        })}
        ${hiddenGroupCount > 0 && filter === 'all'
          ? html`<div class="evidence-group-more">
              +${hiddenGroupCount} more artifacts hidden by evidence display limits
            </div>`
          : nothing}
      </div>
    </details>
  `;
}

function familyEvidenceCompareCards(
  groups: readonly EvidenceGroup[],
  context: FamilyEvidenceRenderContext,
): Array<{ artifact: FamilyObservabilityArtifact; group: EvidenceGroup; index: number }> {
  const seen = new Set<number>();
  const cards: Array<{
    artifact: FamilyObservabilityArtifact;
    group: EvidenceGroup;
    index: number;
  }> = [];
  for (const group of groups) {
    for (const artifact of group.artifacts) {
      const pair = context.pairForArtifact(artifact);
      if (!pair || seen.has(pair.index)) continue;
      seen.add(pair.index);
      cards.push({ artifact, group, index: pair.index });
    }
  }
  return cards;
}

function renderFamilyEvidenceArtifact(
  artifact: FamilyObservabilityArtifact,
  group: EvidenceGroup,
  context: FamilyEvidenceRenderContext,
): TemplateResult {
  const url = context.artifactUrl(artifact);
  const broken = context.isBrokenArtifact(artifact);
  const pair = context.pairForArtifact(artifact);
  const run = group.run;
  return html`
    <div class="artifact-card artifact-wrapper">
      <button
        class="artifact-button"
        @click=${(event: Event) => context.openArtifact(artifact, event)}
      >
        ${broken
          ? html`<div class="artifact-fallback artifact-broken">Preview unavailable</div>`
          : IMAGE_EXTS.test(artifact.path)
            ? html`<img
                class="artifact-preview"
                src=${url}
                alt=${artifact.path}
                loading="lazy"
                @error=${() => context.markArtifactBroken(artifact)}
              />`
            : isRunEvidenceVideoArtifact(artifact)
              ? html`<div class="artifact-video-preview">
                  <video
                    class="artifact-preview"
                    src=${url}
                    muted
                    preload="metadata"
                    @error=${() => context.markArtifactBroken(artifact)}
                  ></video>
                  <span class="artifact-video-review-badge">Open for frame review</span>
                </div>`
              : MARKDOWN_EXTS.test(artifact.path)
                ? context.renderMarkdownPreview(artifact, url)
                : html`<div class="artifact-fallback">${artifact.purpose}</div>`}
        <div class="artifact-meta">
          <div class="artifact-tags">
            <span class="artifact-run-tag">
              ${run ? context.runBadgeLabel(run) : 'run'} ${artifact.runId.slice(0, 8)}
            </span>
            ${run?.slotId
              ? html`<span class="artifact-run-tag">slot ${run.slotId}</span>`
              : nothing}
            ${group.capturedBeforeRun
              ? html`<span class="artifact-run-tag carried">carried over</span>`
              : nothing}
          </div>
          <div class="artifact-purpose">${artifact.purpose}</div>
          <div class="artifact-path">${artifact.path}</div>
          <div class="artifact-caption">${context.artifactCaption(artifact)}</div>
        </div>
      </button>
      ${pair
        ? html`
            <button
              class="compare-chip"
              title="Compare before vs after"
              @click=${(event: Event) => context.openCompare(pair.index, event)}
            >
              Compare ⇆
            </button>
          `
        : nothing}
    </div>
  `;
}

function prStateColor(state: 'OPEN' | 'CLOSED' | 'MERGED'): string {
  if (state === 'MERGED') return colors.statusOk;
  if (state === 'CLOSED') return colors.statusFail;
  return colors.accent;
}

function prUrlForRelated(runs: RelatedRunSummary[], prNumber: number): string | null {
  const ownerRepoRef = runs
    .map((run) => parseGitHubRef(run.ticketOrPr))
    .find((ref) => ref != null && String(ref.number) === String(prNumber));
  if (ownerRepoRef) return githubPullUrl(ownerRepoRef);
  return null;
}

export interface RelatedFamilyDisplayGroup {
  familyId: string;
  runs: RelatedRunSummary[];
  latest: RelatedRunSummary;
  oldest: RelatedRunSummary;
  prNumbers: number[];
  prRecords: PRStatus[];
}

export function relatedFamiliesForDisplay(
  related: RelatedRunSummary[],
  prs: PRStatus[],
): RelatedFamilyDisplayGroup[] {
  const byFamily = new Map<string, RelatedRunSummary[]>();
  for (const run of related) {
    const list = byFamily.get(run.familyId) ?? [];
    list.push(run);
    byFamily.set(run.familyId, list);
  }
  return [...byFamily.entries()]
    .map(([familyId, runs]) => {
      const sorted = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latest = sorted[0];
      const oldest = sorted[sorted.length - 1];
      const prNumbers = [
        ...new Set(runs.map((run) => run.prNumber).filter((n): n is number => n != null)),
      ];
      const prRecords = prNumbers
        .map((pr) => prs.find((candidate) => candidate.pr === pr))
        .filter((pr): pr is PRStatus => pr != null);
      return { familyId, runs: sorted, latest, oldest, prNumbers, prRecords };
    })
    .sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt));
}

export function renderRelatedByTicket(
  related: RelatedRunSummary[],
  prs: PRStatus[],
): TemplateResult | typeof nothing {
  if (!related || related.length === 0) return nothing;
  const families = relatedFamiliesForDisplay(related, prs);
  return html`
    <section class="panel">
      <div class="panel-title">
        Related runs
        <span class="panel-hint"
          >· same ticket/PR, other families (${families.length}
          ${families.length === 1 ? 'family' : 'families'} · ${related.length}
          ${related.length === 1 ? 'run' : 'runs'})</span
        >
      </div>
      <div class="related-list">
        ${families.map((group) => {
          const flow = flowColor(group.latest.flowType);
          const status = runStatusColor(group.latest.status);
          const familyHref = `#family/${group.familyId}?run=${group.latest.runId}`;
          const navigateFamily = () => {
            window.location.hash = familyHref;
          };
          return html`
            <div
              class="related-item"
              role="link"
              tabindex="0"
              @click=${navigateFamily}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                navigateFamily();
              }}
            >
              <div class="run-item-top">
                <span class="badge" style=${`background:${flow}; color:#000`}
                  >${flowLabel(group.latest.flowType)}</span
                >
                <span class="badge status" style=${`border-color:${status}; color:${status}`}
                  >${group.latest.status}</span
                >
                ${group.prRecords.length > 0
                  ? group.prRecords.map((pr) => {
                      const prUrl = pr.repo ? `https://github.com/${pr.repo}/pull/${pr.pr}` : null;
                      const color = prStateColor(pr.prState);
                      const title = `PR #${pr.pr} ${pr.prState.toLowerCase()}${
                        pr.mergeState ? ` · ${pr.mergeState.replace(/_/g, ' ')}` : ''
                      }`;
                      return prUrl
                        ? html`<a
                            class="badge status pr-link"
                            href=${prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style=${`border-color:${color}; color:${color}`}
                            title=${title}
                            @click=${(event: Event) => event.stopPropagation()}
                            >#${pr.pr} ${pr.prState.toLowerCase()}</a
                          >`
                        : html`<span
                            class="badge status"
                            style=${`border-color:${color}; color:${color}`}
                            title=${title}
                            >#${pr.pr} ${pr.prState.toLowerCase()}</span
                          >`;
                    })
                  : group.prNumbers.map((pr) => {
                      const prUrl = prUrlForRelated(group.runs, pr);
                      return prUrl
                        ? html`<a
                            class="badge status pr-link"
                            href=${prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style=${`border-color:${colors.textMuted}; color:${colors.textMuted}`}
                            title="PR state unknown"
                            @click=${(event: Event) => event.stopPropagation()}
                            >#${pr}</a
                          >`
                        : html`<span
                            class="badge status"
                            style=${`border-color:${colors.textMuted}; color:${colors.textMuted}`}
                            title="PR state unknown"
                            >#${pr}</span
                          >`;
                    })}
                ${group.runs.length > 1
                  ? html`<span
                      class="badge status"
                      style=${`border-color:${colors.textMuted}; color:${colors.textMuted}`}
                      >+${group.runs.length - 1} runs</span
                    >`
                  : nothing}
              </div>
              <div class="run-item-title">${group.latest.summary ?? group.latest.ticketOrPr}</div>
              <div class="run-item-meta">
                family ${group.familyId.slice(0, 8)} · ${group.latest.branch ?? 'no branch'} ·
                ${group.runs.length === 1
                  ? formatCreatedAt(group.latest.createdAt)
                  : `${formatCreatedAt(group.oldest.createdAt)} → ${formatCreatedAt(
                      group.latest.createdAt,
                    )}`}
              </div>
            </div>
          `;
        })}
      </div>
    </section>
  `;
}
