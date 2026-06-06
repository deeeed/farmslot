import { html, nothing } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { ArtifactRef } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import {
  buildArtifactUrlResolver,
  rewriteMarkdownArtifactUrls,
} from '../../utils/artifact-markdown.js';
import { renderMarkdown } from '../../utils/markdown.js';
import { createSlotViewRecipeHostEntry } from '../recipe/recipe-quality-hosts.js';
import {
  dedupeWorkspaceEvidenceArtifacts,
  renderWorkspaceEvidencePreview,
} from '../workspace/workspace-evidence-preview.js';

import { isImageRecipeArtifact, isVideoRecipeArtifact } from './slot-view-recipe-helpers.js';
import type { SlotViewRecipePresenter } from './slot-view-recipe-presenter.js';

export function recipeArtifactPurposeLabel(artifact: ArtifactRef): string {
  if (
    artifact.type === 'video' &&
    (artifact.purpose === 'video-before' || artifact.purpose === 'video-after')
  ) {
    return artifact.purpose;
  }
  if (artifact.type) return artifact.type;
  if (artifact.purpose === 'debug-screenshot') return 'screenshot';
  if (artifact.purpose === 'video-before' || artifact.purpose === 'video-after') return 'video';
  return artifact.purpose;
}

export function renderGeneratedVisualArtifacts(
  view: SlotViewRecipePresenter,
  recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
  visualArtifacts: ArtifactRef[],
) {
  const dedupedArtifacts = dedupeWorkspaceEvidenceArtifacts(visualArtifacts);
  if (dedupedArtifacts.length === 0) {
    return html`
      <div
        style="margin-bottom:${spacing.sm}; padding:${spacing.sm}; border:1px dashed ${colors.bgCardHover}; border-radius:${radii.md}; color:${colors.textMuted}; font-size:${fonts.sizeXs};"
      >
        No screenshots or videos are attached to this selected run. Use the diagnostics below for
        logs/trace output.
      </div>
    `;
  }
  return renderWorkspaceEvidencePreview({
    title: 'Generated visual artifacts',
    subtitle: `${dedupedArtifacts.length} screenshot/video artifact${
      dedupedArtifacts.length === 1 ? '' : 's'
    } from this selected run — click one to inspect what the replay proved.`,
    items: dedupedArtifacts.slice(0, 8).map((artifact) => ({
      artifact,
      url: view._artifactUrl(recipeHost, artifact.path),
      selected: view._selectedRecipeArtifactPath === artifact.path,
      openLabel: 'Select preview',
      open: () => {
        view._selectedRecipeArtifactPath =
          view._selectedRecipeArtifactPath === artifact.path ? null : artifact.path;
        view._syncUrlState();
        void view._loadSelectedRecipeArtifactPreview(recipeHost);
      },
    })),
  });
}

export function renderRecipeArtifactPreview(
  view: SlotViewRecipePresenter,
  recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
) {
  const evidenceState = view._recipeNodeEvidenceState(recipeHost);
  const artifact = view._selectedRecipeArtifact(recipeHost);
  if (!artifact) {
    if (evidenceState.mode === 'node' && view._selectedRecipeNodeId) {
      const msg = evidenceState.nodeExists
        ? 'No direct evidence is mapped to this step for the selected recipe run.'
        : 'This step is not present in the selected recipe run.';
      return html`<div
        style="margin-bottom:${spacing.sm}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.md}; background:${colors.bgSurface}; padding:${spacing.md}; color:${colors.textMuted}; font-size:${fonts.sizeXs};"
      >
        ${msg}
      </div>`;
    }
    return nothing;
  }
  const url = view._artifactUrl(recipeHost, artifact.path);
  const markdown = view._selectedRecipeArtifactText || '';
  const markdownResolver = buildArtifactUrlResolver(
    recipeHost?.artifactManifest?.map((entry) => entry.path) ?? [],
    (artifactPath) => view._artifactUrl(recipeHost, artifactPath),
  );
  const renderedMarkdown = renderMarkdown(rewriteMarkdownArtifactUrls(markdown, markdownResolver));
  const lower = artifact.path.toLowerCase();
  const openInViewer = () => {
    view._recipeLightboxScopePaths = null;
    view._recipeLightboxScopeLabel = '';
    const idx = view
      ._recipeLightboxItems(recipeHost)
      .findIndex((item: { path: string }) => item.path === artifact.path);
    if (idx >= 0) {
      view._recipeLightboxIndex = idx;
      view._recipeLightboxOpen = true;
      view._selectedRecipeArtifactPath = artifact.path;
      view._syncUrlState();
    }
  };
  return html`
    <div
      style="margin-bottom:${spacing.sm}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.md}; background:${colors.bgSurface}; overflow:hidden;"
    >
      <div
        style="display:flex; align-items:center; justify-content:space-between; gap:${spacing.sm}; padding:${spacing.sm}; border-bottom:1px solid ${colors.bgCardHover};"
      >
        <div style="display:flex; flex-direction:column; min-width:0;">
          <span
            style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; text-transform:uppercase; letter-spacing:0.08em;"
            >Selected artifact</span
          >
          <span
            style="font-family:${fonts.mono}; font-size:${fonts.sizeXs}; color:${colors.textSecondary}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
            >${artifact.path}</span
          >
        </div>
        <button class="sv-action-btn" @click=${openInViewer}>Open</button>
      </div>
      ${isImageRecipeArtifact(artifact)
        ? html`<img
            src=${url}
            alt=${artifact.path}
            style="display:block; width:100%; max-height:280px; object-fit:contain; background:${colors.bgBase};"
          />`
        : isVideoRecipeArtifact(artifact)
          ? html`<video
              src=${url}
              controls
              style="display:block; width:100%; max-height:280px; background:${colors.bgBase};"
            ></video>`
          : /\.(md|markdown)$/i.test(lower)
            ? html`<div
                style="padding:${spacing.md}; max-height:280px; overflow:auto; font-size:${fonts.sizeXs}; color:${colors.textSecondary};"
              >
                ${view._selectedRecipeArtifactLoading
                  ? html`Loading…`
                  : view._selectedRecipeArtifactError
                    ? html`<span style="color:${colors.statusWarn};"
                        >Failed to load artifact: ${view._selectedRecipeArtifactError}</span
                      >`
                    : unsafeHTML(renderedMarkdown)}
              </div>`
            : /\.(json)$/i.test(lower)
              ? html`<pre
                  style="margin:0; padding:${spacing.md}; max-height:280px; overflow:auto; background:${colors.bgBase}; color:${colors.textSecondary}; font-size:${fonts.sizeXs};"
                >
${view._selectedRecipeArtifactLoading
                    ? 'Loading…'
                    : view._selectedRecipeArtifactError
                      ? `Failed to load artifact: ${view._selectedRecipeArtifactError}`
                      : view._selectedRecipeArtifactText}</pre
                >`
              : /\.(js|ts|txt|jsonl)$/i.test(lower)
                ? html`<pre
                    style="margin:0; padding:${spacing.md}; max-height:280px; overflow:auto; background:${colors.bgBase}; color:${colors.textSecondary}; font-size:${fonts.sizeXs};"
                  >
${view._selectedRecipeArtifactLoading
                      ? 'Loading…'
                      : view._selectedRecipeArtifactError
                        ? `Failed to load artifact: ${view._selectedRecipeArtifactError}`
                        : view._selectedRecipeArtifactText}</pre
                  >`
                : html`<div
                    style="padding:${spacing.md}; font-size:${fonts.sizeXs}; color:${colors.textMuted};"
                  >
                    Preview not embedded for this artifact type. Use <strong>Open</strong> to
                    inspect it in the viewer.
                  </div>`}
    </div>
  `;
}
