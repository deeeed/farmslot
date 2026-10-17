/**
 * A retained HTML report renders in a WebView, isolated the way Command Center isolates it:
 * the shared artifact CSP, no scripts, and every navigation decided here. Relative links
 * open the retained artifact they name, web links open outside the app on a tap, and
 * nothing else loads.
 */
import { ARTIFACT_HTML_CSP, buildArtifactUrlResolver } from '@farmslot/review-dispatch';

const REPORT_HOST = 'farmslot-report.invalid';

/** The page's own URL: unreachable, so a relative link arrives as a URL that maps back. */
export const REPORT_DOCUMENT_BASE = `https://${REPORT_HOST}/document/`;

/** The report behind the shared CSP, without refresh redirects that could leave the page unasked. */
export function isolatedReportHtml(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_HTML_CSP}">`;
  const withoutRefresh = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '');
  return /<head\b[^>]*>/i.test(withoutRefresh)
    ? withoutRefresh.replace(/<head\b[^>]*>/i, (head) => `${head}${meta}`)
    : `${meta}${withoutRefresh}`;
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
    try {
      const path = resolveArtifact(decodeURIComponent(target.slice(REPORT_DOCUMENT_BASE.length)));
      return path ? { kind: 'artifact', path } : { kind: 'blocked' };
    } catch {
      return { kind: 'blocked' };
    }
  }
  try {
    const external = new URL(url);
    if (
      ['http:', 'https:'].includes(external.protocol) &&
      external.hostname !== REPORT_HOST &&
      !external.username &&
      !external.password
    )
      return { kind: 'external', url };
  } catch {
    // Not a URL at all: nothing to open.
  }
  return { kind: 'blocked' };
}
