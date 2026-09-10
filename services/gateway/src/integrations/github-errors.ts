/** Structured GitHub error classification; never infer pagination state from CLI-rendered text. */
export function hasInvalidGitHubCursor(errors: unknown): boolean {
  return (
    Array.isArray(errors) &&
    errors.some(
      (error) =>
        error &&
        typeof error === 'object' &&
        ['INVALID_CURSOR_ARGUMENTS', 'INVALID_CURSOR_ARGUMENT', 'INVALID_CURSOR'].includes(
          error.type,
        ),
    )
  );
}
export class GitHubCursorError extends Error {
  constructor() {
    super('GitHub rejected the pagination cursor');
    this.name = 'GitHubCursorError';
  }
}
