import { html, nothing, type TemplateResult } from 'lit';

import type { ArtifactRef } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

import {
  IMAGE_EXTS,
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
  const withoutFinalExtension = basename.replace(/\.(png|jpg|jpeg|gif|mp4|mov|webm)$/i, '');
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

export function renderWorkspaceEvidencePreview(input: {
  title: string;
  subtitle?: string;
  items: WorkspaceEvidencePreviewItem[];
  totalCount?: number;
  overflowHint?: string;
  compact?: boolean;
  empty?: TemplateResult | typeof nothing;
}): TemplateResult | typeof nothing {
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
          <span
            style="font-size:${fonts.sizeXs}; text-transform:uppercase; letter-spacing:0.08em; color:${colors.textMuted}; font-weight:700;"
            >${input.title}</span
          >
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
          const isImage = IMAGE_EXTS.test(artifact.path);
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
                      src=${url}
                      alt=${label}
                      loading="lazy"
                      style="width:100%; height:100%; object-fit:contain; display:block;"
                    />`
                  : isVideo
                    ? html`<video
                        src=${url}
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
