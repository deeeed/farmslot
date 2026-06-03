import { html } from 'lit';

import type { FamilyObservabilityArtifact } from '@farmslot/protocol';

import type { MdFetchEntry } from '../../utils/markdown.js';

import { familyArtifactKey } from './family-observability-artifact-model.js';

export function familyMarkdownPreviewFetchPath(gatewayBase: string, url: string): string {
  return url.startsWith(gatewayBase) ? url.slice(gatewayBase.length) : url;
}

export function familyMarkdownPreviewText(markdown: string): string {
  return (
    markdown
      .replace(/^---[\s\S]*?---\s*/m, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/[#>*_`~]+/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  ).slice(0, 140);
}

export function familyMarkdownPreviewDisplay(entry: MdFetchEntry<string> | undefined): string {
  if (entry?.status === 'ok') return entry.data;
  if (entry?.status === 'err') return 'Preview failed';
  return '…';
}

export function renderFamilyMarkdownPreview(
  artifact: FamilyObservabilityArtifact,
  entry: MdFetchEntry<string> | undefined,
) {
  return html`
    <div class="artifact-md-preview" data-artifact-key=${familyArtifactKey(artifact)}>
      <div class="artifact-md-badge">MD</div>
      <div class="artifact-md-firstline">${familyMarkdownPreviewDisplay(entry)}</div>
    </div>
  `;
}
