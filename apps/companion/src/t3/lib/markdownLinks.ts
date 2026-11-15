// From T3 Code apps/mobile/src/lib/markdownLinks.ts (b8c2cfad): link presentation without T3's
// file icons, thread links and video previews, which Companion does not have.
import { fileLinkLabel } from '../shared/fileLinks';
import {
  inlineCodeFilePathCandidate,
  normalizeMarkdownLinkDestination,
  parseMarkdownFileLink,
} from '../shared/markdownLinks';

export type MarkdownLinkPresentation =
  | {
      readonly kind: 'external';
      readonly href: string;
      readonly host: string;
    }
  | {
      readonly kind: 'file';
      readonly href: string;
      readonly label: string;
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
    }
  | {
      readonly kind: 'link';
      readonly href: string | null;
    };

/** Native link and media APIs have no document scheme to inherit from protocol-relative URLs. */
export function normalizeNativeMarkdownUrl(value: string): string {
  return value.startsWith('//') ? `https:${value}` : value;
}

/** An http(s) URL, or null for any destination that is not one (a path, a fragment, a word). */
function externalUrl(value: string): URL | null {
  if (!/^https?:\/\//i.test(value)) return null;
  // The scheme matched, so a parse failure is a malformed address: show it as a plain link.
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function resolveMarkdownLinkPresentation(href: string): MarkdownLinkPresentation {
  const normalized = normalizeMarkdownLinkDestination(href);
  const parsed = externalUrl(normalizeNativeMarkdownUrl(normalized));
  if (parsed) {
    return {
      kind: 'external',
      href: parsed.toString(),
      host: parsed.hostname,
    };
  }

  const target = parseMarkdownFileLink(normalized);
  if (target) {
    return {
      kind: 'file',
      href: normalized,
      label: fileLinkLabel(target, new Map()),
      path: target.path,
      ...(target.line ? { line: target.line } : {}),
      ...(target.column ? { column: target.column } : {}),
    };
  }

  return {
    kind: 'link',
    href: /^(?:mailto|tel):/i.test(normalized) ? normalized : null,
  };
}

export function resolveMarkdownInlineCodePresentation(
  content: string,
): Extract<MarkdownLinkPresentation, { readonly kind: 'file' }> | null {
  const candidate = inlineCodeFilePathCandidate(content);
  if (candidate === null) return null;
  const presentation = resolveMarkdownLinkPresentation(candidate);
  return presentation.kind === 'file' ? presentation : null;
}
