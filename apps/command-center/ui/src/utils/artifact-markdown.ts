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

export function rewriteMarkdownArtifactUrls(
  markdown: string,
  resolveUrl: (rawUrl: string) => string | null,
): string {
  const withHtmlUrls = markdown.replace(
    /\b(src|href)=(["'])([^"']+)\2/gi,
    (match, attr: string, quote: string, rawUrl: string) => {
      const resolved = resolveUrl(rawUrl);
      return resolved ? `${attr}=${quote}${resolved}${quote}` : match;
    },
  );

  return withHtmlUrls.replace(
    /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+["'][^"']*["'])?\))/g,
    (match, prefix: string, rawUrl: string, suffix: string) => {
      const resolved = resolveUrl(rawUrl);
      return resolved ? `${prefix}${resolved}${suffix}` : match;
    },
  );
}
