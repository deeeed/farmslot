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

function generatedArtifactLabel(artifactPath: string): string {
  const basename = artifactPath.replace(/\\/g, '/').split('/').pop() ?? artifactPath;
  const withoutFinalExtension = basename.replace(/\.(png|jpg|jpeg|gif|mp4|mov|webm)$/i, '');
  // Some runner filenames preserve the source extension before appending a timestamp/preview
  // extension, so strip both the final and embedded visual suffixes before humanizing.
  const withoutTimestamp = withoutFinalExtension.replace(/-\d{10,}(?:\.\w+)?$/i, '');
  const withoutEmbeddedExtension = withoutTimestamp.replace(
    /\.(png|jpg|jpeg|gif|mp4|mov|webm)$/i,
    '',
  );
  const withoutEvidencePrefix = withoutEmbeddedExtension.replace(/^evidence[-_]?/i, '');
  return withoutEvidencePrefix
    .replace(/[-_]+/g, ' ')
    .replace(/\bac(\d+)\b/gi, 'AC$1')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function artifactDisplayLabel(artifact: ArtifactRef): string {
  return artifact.label?.trim() || generatedArtifactLabel(artifact.path);
}

export function renderGeneratedVisualArtifacts(
  view: SlotViewRecipePresenter,
  recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
  visualArtifacts: ArtifactRef[],
) {
  if (visualArtifacts.length === 0) {
    return html`
      <div
        style="margin-bottom:${spacing.sm}; padding:${spacing.sm}; border:1px dashed ${colors.bgCardHover}; border-radius:${radii.md}; color:${colors.textMuted}; font-size:${fonts.sizeXs};"
      >
        No screenshots or videos are attached to this selected run. Use the diagnostics below for
        logs/trace output.
      </div>
    `;
  }
  return html`
    <div
      style="margin-bottom:${spacing.sm}; padding:${spacing.sm}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.md}; background:${colors.bgSurface};"
    >
      <div
        style="display:flex; align-items:center; justify-content:space-between; gap:${spacing.sm}; margin-bottom:${spacing.xs};"
      >
        <div style="display:flex; flex-direction:column; gap:2px;">
          <span
            style="font-size:${fonts.sizeXs}; text-transform:uppercase; letter-spacing:0.08em; color:${colors.textMuted}; font-weight:700;"
            >Generated visual artifacts</span
          >
          <span style="font-size:${fonts.sizeXs}; color:${colors.textSecondary};">
            ${visualArtifacts.length} screenshot/video
            artifact${visualArtifacts.length === 1 ? '' : 's'} from this selected run — click one to
            inspect what the replay proved.
          </span>
        </div>
      </div>
      <div
        style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:${spacing.sm};"
      >
        ${visualArtifacts.slice(0, 8).map((artifact) => {
          const selected = view._selectedRecipeArtifact(recipeHost)?.path === artifact.path;
          const url = view._artifactUrl(recipeHost, artifact.path);
          return html`
            <button
              data-testid=${`slot-recipe-visual-artifact-${artifact.path.replace(/^artifacts\//, '').replace(/[^a-zA-Z0-9_-]+/g, '-')}`}
              style="display:flex; flex-direction:column; gap:6px; text-align:left; border:1px solid ${selected
                ? colors.accent
                : colors.bgCardHover}; border-radius:${radii.md}; background:${selected
                ? `${colors.accent}16`
                : colors.bgCard}; color:${colors.textPrimary}; padding:${spacing.xs}; cursor:pointer; overflow:hidden;"
              @click=${() => {
                view._selectedRecipeArtifactPath =
                  view._selectedRecipeArtifactPath === artifact.path ? null : artifact.path;
                view._syncUrlState();
                void view._loadSelectedRecipeArtifactPreview(recipeHost);
              }}
            >
              <div
                style="height:112px; border-radius:${radii.sm}; overflow:hidden; background:${colors.bgBase}; border:1px solid ${colors.bgCardHover}; display:flex; align-items:center; justify-content:center;"
              >
                ${isImageRecipeArtifact(artifact)
                  ? html`<img
                      src=${url}
                      alt=${artifactDisplayLabel(artifact)}
                      style="width:100%; height:100%; object-fit:contain;"
                    />`
                  : html`<video
                      src=${url}
                      muted
                      style="width:100%; height:100%; object-fit:contain;"
                    ></video>`}
              </div>
              <span
                style="font-size:${fonts.sizeXs}; color:${colors.textPrimary}; font-weight:700;"
              >
                ${artifactDisplayLabel(artifact)}
              </span>
              <span
                style="font-family:${fonts.mono}; font-size:${fonts.sizeXs}; color:${colors.textMuted}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
              >
                ${artifact.path}
              </span>
            </button>
          `;
        })}
      </div>
      ${visualArtifacts.length > 8
        ? html`<div
            style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-top:${spacing.xs};"
          >
            +${visualArtifacts.length - 8} more visual artifact(s) in the grid below.
          </div>`
        : nothing}
    </div>
  `;
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
