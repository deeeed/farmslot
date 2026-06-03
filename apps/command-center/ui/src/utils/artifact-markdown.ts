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
): (rawUrl: string) => string | null {
  const byPath = new Map<string, string>();
  for (const artifactPath of artifactPaths) {
    const normalized = artifactPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
    byPath.set(normalized, artifactPath);
    const basename = normalized.split('/').pop();
    if (basename && !byPath.has(basename)) byPath.set(basename, artifactPath);
  }

  return (rawUrl: string) => {
    const candidate = normalizeArtifactCandidate(rawUrl);
    if (!candidate) return null;
    const artifactPath = byPath.get(candidate) ?? byPath.get(candidate.split('/').pop() ?? '');
    return artifactPath ? toUrl(artifactPath) : null;
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
