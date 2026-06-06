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
  selected?: boolean;
}

export function dedupeWorkspaceEvidenceArtifacts(artifacts: readonly ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  const deduped: ArtifactRef[] = [];
  for (const artifact of artifacts) {
    const key = artifact.sha256 ? `sha:${artifact.sha256}` : `path:${artifact.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(artifact);
  }
  return deduped;
}

function evidenceTypeLabel(artifact: ArtifactRef): string {
  if (IMAGE_EXTS.test(artifact.path)) return workspaceArtifactTypeBadge('image');
  if (VIDEO_EXTS.test(artifact.path)) return workspaceArtifactTypeBadge('video');
  return workspaceArtifactTypeBadge('other');
}

export function renderWorkspaceEvidencePreview(input: {
  title: string;
  subtitle?: string;
  items: WorkspaceEvidencePreviewItem[];
  compact?: boolean;
  empty?: TemplateResult | typeof nothing;
}): TemplateResult | typeof nothing {
  if (input.items.length === 0) return input.empty ?? nothing;
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
          >${input.items.length} artifact${input.items.length === 1 ? '' : 's'}</span
        >
      </div>
      <div
        style="display:grid; grid-template-columns:repeat(auto-fit, minmax(${input.compact
          ? '160px'
          : '200px'}, 1fr)); gap:${spacing.sm};"
      >
        ${input.items.map(({ artifact, url, open, selected }) => {
          const isImage = IMAGE_EXTS.test(artifact.path);
          const isVideo = VIDEO_EXTS.test(artifact.path);
          const name = workspaceArtifactBasename(artifact.path);
          const clickable = Boolean(open);
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
              role=${clickable ? 'button' : 'listitem'}
              tabindex=${clickable ? '0' : '-1'}
              @click=${() => open?.()}
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
                      alt=${artifact.label ?? name}
                      loading="lazy"
                      style="width:100%; height:100%; object-fit:contain; display:block;"
                    />`
                  : isVideo
                    ? html`<video
                        src=${url}
                        controls
                        muted
                        preload="metadata"
                        @click=${(event: Event) => event.stopPropagation()}
                        @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
                        style="width:100%; height:100%; object-fit:contain; display:block;"
                      ></video>`
                    : html`<span style="font-size:${fonts.sizeXs}; color:${colors.textMuted};"
                        >${evidenceTypeLabel(artifact)}</span
                      >`}
              </div>
              <span
                style="font-size:${fonts.sizeXs}; color:${colors.textPrimary}; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
                title=${artifact.label ?? name}
              >
                ${artifact.label ?? name}
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
    </section>
  `;
}
