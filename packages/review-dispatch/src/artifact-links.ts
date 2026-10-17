/**
 * Retained report documents link to the run's other artifacts by relative path. Command
 * Center and Companion resolve those links, and isolate the document, from one place.
 */

/** Retained HTML is an untrusted document: no scripts, no network, data: media only. */
export const ARTIFACT_HTML_CSP =
  "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

/** An HTML artifact renders as an isolated page rather than as text. */
export function isHtmlArtifactPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

/**
 * A report link that may open outside the page: an absolute http(s) URL with no credentials.
 * A string check rather than `URL`, so both clients decide alike: React Native's `URL` is not
 * the WHATWG parser.
 */
export function isExternalWebLink(href: string): boolean {
  const authority = /^https?:\/\/([^/?#]*)/i.exec(href)?.[1] ?? '';
  return authority !== '' && !authority.includes('@');
}

/** A link as written in the page, percent-decoded; null when it cannot be decoded. */
export function decodeArtifactLink(href: string): string | null {
  try {
    return decodeURIComponent(href);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

function normalizeArtifactCandidate(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(trimmed)) return null;
  const [pathPart] = trimmed.split(/[?#]/, 1);
  const withoutDot = pathPart.replace(/^\.\/+/, '');
  if (!withoutDot || withoutDot.split(/[\\/]+/).includes('..')) return null;
  return withoutDot;
}

export function buildArtifactUrlResolver(
  artifactPaths: Iterable<string>,
  toUrl: (artifactPath: string) => string,
  documentPath?: string,
): (rawUrl: string) => string | null {
  const byPath = new Map<string, string>();
  const byBasename = new Map<string, string | null>();
  for (const artifactPath of artifactPaths) {
    const normalized = artifactPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
    byPath.set(normalized, artifactPath);
    const basename = normalized.split('/').pop();
    if (basename) {
      const previous = byBasename.get(basename);
      byBasename.set(
        basename,
        previous === undefined || previous === artifactPath ? artifactPath : null,
      );
    }
  }

  return (rawUrl: string) => {
    const candidate = normalizeArtifactCandidate(rawUrl);
    if (!candidate) return null;
    const directory = documentPath?.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const artifactPath =
      (directory ? byPath.get(`${directory}/${candidate}`) : undefined) ??
      byPath.get(candidate) ??
      (!candidate.includes('/') ? byBasename.get(candidate) : undefined);
    // Older frozen packages may omit media from their inventory. Explicit task
    // artifact paths still go through the gateway's authenticated, confined route.
    return artifactPath
      ? toUrl(artifactPath)
      : candidate.startsWith('artifacts/')
        ? toUrl(candidate)
        : null;
  };
}
