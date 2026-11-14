export function redactLogContent(content: string): string {
  return content
    .replace(/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(gh[pousrv]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b(xox[ea]-[A-Za-z0-9-]{20,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b(xapp-[A-Za-z0-9-]{20,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key)=([^\s]+)/gi,
      (_match, key: string, value: string) =>
        value.startsWith('[REDACTED') ? `${key}=${value}` : `${key}=[REDACTED]`,
    );
}
