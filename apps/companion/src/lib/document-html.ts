/**
 * A retained HTML report renders in a WebView, isolated the way Command Center isolates it:
 * the shared artifact CSP, no scripts, and every navigation decided here. Relative links
 * open the retained artifact they name, web links open outside the app on a tap, and
 * nothing else loads.
 */
import {
  ARTIFACT_HTML_CSP,
  buildArtifactUrlResolver,
  decodeArtifactLink,
  isExternalWebLink,
} from '@farmslot/review-dispatch';

/** The page's own origin: unreachable, so a relative link arrives as a URL that maps back. */
const REPORT_ORIGIN = 'https://farmslot-report.invalid/';
export const REPORT_DOCUMENT_BASE = `${REPORT_ORIGIN}document/`;

const META_TAG = /<meta\b[^>]*>/gi;

/**
 * The report behind the shared CSP. Every authored meta tag goes, as Command Center's
 * sanitizer drops them: a refresh could leave the page unasked, however its value is
 * encoded. Removal repeats so that it cannot join the pieces of a new tag.
 */
export function isolatedReportHtml(html: string): string {
  let stripped = html;
  for (let previous = ''; previous !== stripped; ) {
    previous = stripped;
    stripped = stripped.replace(META_TAG, '');
  }
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_HTML_CSP}">`;
  return /<head\b[^>]*>/i.test(stripped)
    ? stripped.replace(/<head\b[^>]*>/i, (tag) => `${tag}${head}`)
    : `${head}${stripped}`;
}

/** Report links resolve to retained artifacts exactly as Command Center resolves them. */
export function reportArtifactResolver(
  artifactPaths: Iterable<string>,
  reportPath: string,
): (relativeHref: string) => string | null {
  return buildArtifactUrlResolver(artifactPaths, (path) => path, reportPath);
}

export type ReportNavigation =
  | { kind: 'document' }
  | { kind: 'artifact'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'blocked' };

export function reportNavigation(
  url: string,
  resolveArtifact: (relativeHref: string) => string | null,
  userInitiated: boolean,
): ReportNavigation {
  const [target] = url.split('#');
  // The initial load and in-page anchors stay in the report.
  if (target === REPORT_DOCUMENT_BASE || target === 'about:blank') return { kind: 'document' };
  if (!userInitiated) return { kind: 'blocked' };
  if (target.startsWith(REPORT_DOCUMENT_BASE)) {
    const href = decodeArtifactLink(target.slice(REPORT_DOCUMENT_BASE.length));
    const path = href === null ? null : resolveArtifact(href);
    return path ? { kind: 'artifact', path } : { kind: 'blocked' };
  }
  if (!url.startsWith(REPORT_ORIGIN) && isExternalWebLink(url)) return { kind: 'external', url };
  return { kind: 'blocked' };
}
