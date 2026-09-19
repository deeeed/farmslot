// Diff-view classification: which changed files are tests, and how a change
// splits between code and tests. Shared by the gateway (which stamps each
// branch-diff file) and Command Center (which hides tests and shows the ratio).

import { compileGlob, globDoubleStarRuns } from './glob.js';

export type DiffFileKind = 'code' | 'test';

/**
 * Default test-file globs, matched against the repo-relative path.
 *
 * Pattern rules (a subset of gitignore): a double star followed by a slash
 * spans any depth of directories, a trailing one everything below, and any
 * other double star is a plain star; `*` and `?` stay inside one segment. A pattern without a slash names
 * a path segment anywhere: `fixtures` matches `src/fixtures/a.json` and a
 * file named `fixtures`; `*.snap` matches any `.snap` file. A trailing slash
 * names a directory anywhere: `tests/` matches `src/a/tests/x.ts`. Because a
 * bare name is a segment rule, a bare filename glob also covers anything below
 * a directory of that name (`*.snap` would match `x.snap/readme.md`). A pattern
 * with an inner slash is anchored at the repo root unless it starts with a
 * double star and a slash. Matching is case-sensitive so `*Test.java` does
 * not catch `latest.java`.
 *
 * No bare `spec` directory rule is included: `spec` directories hold
 * production schemas in some repos (this one included); `*.spec.*` and
 * `*_spec.rb` cover spec test files by name. Projects extend or replace these
 * defaults through `project.json` `diff_view`.
 *
 * Compiled by the shared `compileGlob` in segment anchoring, case-sensitive.
 * The gateway's `source-diff-filter` uses the same compiler in anchored,
 * case-insensitive mode to mirror git pathspecs.
 */
export const DEFAULT_TEST_FILE_PATTERNS: readonly string[] = [
  '*.test.*',
  '*.spec.*',
  '*_test.go',
  '*_test.py',
  'test_*.py',
  '*_test.rb',
  '*_spec.rb',
  '*Test.java',
  '*Tests.java',
  '*Test.kt',
  '*Tests.kt',
  '*Test.swift',
  '*Tests.swift',
  '*.snap',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/__snapshots__/**',
  '**/test/**',
  '**/tests/**',
  '**/e2e/**',
];

/** `project.json` `diff_view` block, already read into camelCase. */
export interface DiffViewTestPatternConfig {
  /** Extra globs on top of (or instead of) the defaults. */
  testPatterns?: readonly string[];
  /** Set false to use only `testPatterns`. Defaults to true. */
  useDefaultTestPatterns?: boolean;
}

/** Caps on project-supplied patterns, matching the gateway's source-diff filter. */
export const TEST_FILE_PATTERN_ENTRY_LIMIT = 256;
export const TEST_FILE_PATTERN_CHAR_LIMIT = 256;
/**
 * Most double-star runs one pattern may keep. Each run compiles to an
 * optional `.*` group and a non-matching path backtracks across all of them.
 * Four admits `**` / dir / `**` / dir / `**` / glob, the deepest monorepo
 * shape seen in practice; patterns with more are dropped with a warning.
 * This trims the surface rather than closing the class: a long run of `*`
 * inside one segment can still backtrack on a pathological path, which real
 * repo paths (a few segments, ~100 chars) do not produce.
 */
export const TEST_FILE_PATTERN_DOUBLE_STAR_LIMIT = 4;

export function resolveTestFilePatterns(
  config?: DiffViewTestPatternConfig | null,
): readonly string[] {
  const custom = (config?.testPatterns ?? [])
    .map((pattern) => pattern.trim())
    .filter((pattern) => {
      if (pattern.length === 0) return false;
      if (pattern.length > TEST_FILE_PATTERN_CHAR_LIMIT) {
        console.warn(
          `[diff-view] dropping test pattern longer than ${TEST_FILE_PATTERN_CHAR_LIMIT} chars: ${pattern.slice(0, 40)}…`,
        );
        return false;
      }
      if (globDoubleStarRuns(pattern) > TEST_FILE_PATTERN_DOUBLE_STAR_LIMIT) {
        console.warn(
          `[diff-view] dropping test pattern with more than ${TEST_FILE_PATTERN_DOUBLE_STAR_LIMIT} double-star runs: ${pattern}`,
        );
        return false;
      }
      const compiled = compileGlob(pattern, { anchoring: 'segment', caseSensitive: true });
      if (compiled.invalid) {
        // Dropped here so the effective list handed to clients is honest.
        console.warn(`[diff-view] dropping test pattern "${compiled.pattern}": ${compiled.reason}`);
        return false;
      }
      return true;
    })
    .slice(0, TEST_FILE_PATTERN_ENTRY_LIMIT);
  const useDefaults = config?.useDefaultTestPatterns !== false;
  return [...(useDefaults ? DEFAULT_TEST_FILE_PATTERNS : []), ...custom];
}

export type TestFileMatcher = (path: string) => boolean;

export function compileTestFileMatcher(
  patterns: readonly string[] = DEFAULT_TEST_FILE_PATTERNS,
): TestFileMatcher {
  // Defensive for callers that bypass resolveTestFilePatterns.
  const regexes: RegExp[] = [];
  for (const pattern of patterns) {
    if (globDoubleStarRuns(pattern) > TEST_FILE_PATTERN_DOUBLE_STAR_LIMIT) continue;
    const compiled = compileGlob(pattern, { anchoring: 'segment', caseSensitive: true });
    if (compiled.invalid) {
      console.warn(`[diff-view] dropping test pattern "${compiled.pattern}": ${compiled.reason}`);
      continue;
    }
    regexes.push(compiled.regex);
  }
  return (path) => {
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
    return regexes.some((regex) => regex.test(normalized));
  };
}

export const DEFAULT_TEST_FILE_MATCHER: TestFileMatcher = compileTestFileMatcher();

export function classifyDiffFile(
  path: string,
  matcher: TestFileMatcher = DEFAULT_TEST_FILE_MATCHER,
): DiffFileKind {
  return matcher(path) ? 'test' : 'code';
}

export interface DiffKindSummary {
  codeFiles: number;
  testFiles: number;
  /** Additions + deletions in code files. */
  codeLines: number;
  /** Additions + deletions in test files. */
  testLines: number;
  /** Test share of changed lines in [0, 1]; null when nothing changed. */
  testShare: number | null;
}

/** Uses a file's stamped `kind` when present, else classifies its path. */
export function summarizeDiffKinds(
  files: readonly { path: string; additions: number; deletions: number; kind?: DiffFileKind }[],
  matcher: TestFileMatcher = DEFAULT_TEST_FILE_MATCHER,
): DiffKindSummary {
  const summary: DiffKindSummary = {
    codeFiles: 0,
    testFiles: 0,
    codeLines: 0,
    testLines: 0,
    testShare: null,
  };
  for (const file of files) {
    const kind = file.kind ?? classifyDiffFile(file.path, matcher);
    const lines = file.additions + file.deletions;
    if (kind === 'test') {
      summary.testFiles += 1;
      summary.testLines += lines;
    } else {
      summary.codeFiles += 1;
      summary.codeLines += lines;
    }
  }
  const total = summary.codeLines + summary.testLines;
  summary.testShare = total > 0 ? summary.testLines / total : null;
  return summary;
}
