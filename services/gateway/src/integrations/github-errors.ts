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

/** Only a missing repository/PR is non-ownership; nested field failures stay uncertain. */
export function hasUnavailableGitHubPR(errors: unknown): boolean {
  return (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every(
      (error) =>
        error?.type === 'NOT_FOUND' &&
        Array.isArray(error.path) &&
        (JSON.stringify(error.path) === '["repository"]' ||
          JSON.stringify(error.path) === '["repository","pullRequest"]'),
    )
  );
}
export class GitHubPRUnavailableError extends Error {
  constructor() {
    super('Requested PR is unavailable to the team account');
    this.name = 'GitHubPRUnavailableError';
  }
}
