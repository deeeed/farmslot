import { renderMarkdown } from '../../utils/markdown.js';

export type MediaLightboxTextPreviewKind = 'markdown' | 'json' | 'diff';

export interface SameOriginLightboxFetchUrlInput {
  url: string;
  locationHref: string;
  windowOrigin: string;
  gatewayOrigin: string;
}

// Convert a same-origin absolute URL to a path-only URL so dev-mode fetches
// flow through the vite proxy (and therefore pick up gateway CORS handling).
// Off-origin URLs are returned unchanged so the browser's CORS check still applies.
export function sameOriginLightboxFetchUrl(input: SameOriginLightboxFetchUrlInput): string {
  try {
    const parsed = new URL(input.url, input.locationHref);
    const current = new URL(input.locationHref);
    const hostedCommandCenter = current.pathname === '/cc' || current.pathname.startsWith('/cc/');
    if (
      parsed.origin === input.windowOrigin ||
      (parsed.origin === input.gatewayOrigin && !hostedCommandCenter)
    ) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return input.url;
  } catch {
    return input.url;
  }
}

export function formatLightboxTextPreview(
  kind: MediaLightboxTextPreviewKind,
  text: string,
  markdownRenderer: (markdown: string) => string = renderMarkdown,
): string {
  if (kind === 'markdown') return markdownRenderer(text);
  if (kind === 'diff') return text;

  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Preserve existing behavior: malformed JSON falls back to raw text.
    return text;
  }
}
