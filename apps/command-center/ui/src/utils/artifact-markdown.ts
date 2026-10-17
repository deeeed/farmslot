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
