// A scope is one or more comma-separated tokens. Conventional Commits v1.0.0
// only requires "a noun describing a section of the codebase surrounded by
// parenthesis" and does not forbid commas; comma-separated multi-scope is
// common practice and commitlint supports it. Rejecting it blocked
// `feat(gateway,node): ...`, a legitimate subject, on a change that spanned both.
// Each token keeps the original strict shape, so junk scopes still fail.
const SCOPE_TOKEN = '[a-z0-9][a-z0-9._/-]*';

export const CONVENTIONAL_SUBJECT = new RegExp(
  `^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)` +
    `(\\(${SCOPE_TOKEN}(?: *, *${SCOPE_TOKEN})*\\))?!?: \\S.+$`,
);

export function isConventionalCommitSubject(subject) {
  return typeof subject === 'string' && CONVENTIONAL_SUBJECT.test(subject);
}
