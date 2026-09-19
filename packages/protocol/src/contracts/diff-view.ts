// Diff-view classification: which changed files are tests, and how a change
// splits between code and tests. Shared by the gateway (which stamps each
// branch-diff file) and Command Center (which hides tests and shows the ratio).

export type DiffFileKind = 'code' | 'test';

/**
 * Default test-file globs, matched against the repo-relative path.
 *
 * Pattern rules (a subset of gitignore): a double star spans directories,
 * `*` and `?` stay inside one path segment. A pattern without a slash names
 * a path segment anywhere: `fixtures` matches `src/fixtures/a.json` and a
 * file named `fixtures`; `*.snap` matches any `.snap` file. A trailing slash
 * names a directory anywhere: `tests/` matches `src/a/tests/x.ts`. A pattern
 * with an inner slash is anchored at the repo root unless it starts with a
 * double star and a slash. Matching is case-sensitive so `*Test.java` does
 * not catch `latest.java`.
 *
 * No bare `spec` directory rule is included: `spec` directories hold
 * production schemas in some repos (this one included); `*.spec.*` and
 * `*_spec.rb` cover spec test files by name. Projects extend or replace these
 * defaults through `project.json` `diff_view`.
 *
 * This compiler is separate from the gateway's `source-diff-filter`, which
 * also emits git pathspecs, applies allow/block semantics, and is
 * case-insensitive; this one must run in the browser and only answers
 * "is this a test file".
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

export function resolveTestFilePatterns(
  config?: DiffViewTestPatternConfig | null,
): readonly string[] {
  const custom = (config?.testPatterns ?? [])
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0 && pattern.length <= TEST_FILE_PATTERN_CHAR_LIMIT)
    .slice(0, TEST_FILE_PATTERN_ENTRY_LIMIT);
  const useDefaults = config?.useDefaultTestPatterns !== false;
  return [...(useDefaults ? DEFAULT_TEST_FILE_PATTERNS : []), ...custom];
}

function globToRegExp(pattern: string): RegExp {
  let glob = pattern
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    // Runs of `**/` mean the same as one; compiling each into its own optional
    // group makes a non-match backtrack exponentially.
    .replace(/(?:\*\*\/)+/g, '**/');
  const directoryOnly = glob.endsWith('/');
  if (directoryOnly) glob = glob.replace(/\/+$/, '');
  // No inner slash: the pattern names a single path segment anywhere.
  const segmentAnywhere = !glob.includes('/');
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      const atSegmentStart = i === 0 || glob[i - 1] === '/';
      if (atSegmentStart && glob[i + 2] === '/') {
        // `**/` — zero or more whole directories.
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  const prefix = segmentAnywhere ? '(?:.*/)?' : '';
  // A segment pattern also matches everything below a directory of that
  // name; a directory-only pattern matches only what lies below it.
  const suffix = segmentAnywhere
    ? directoryOnly
      ? '/.*'
      : '(?:/.*)?'
    : directoryOnly
      ? '/.*'
      : '';
  return new RegExp(`^${prefix}${out}${suffix}$`);
}

export type TestFileMatcher = (path: string) => boolean;

export function compileTestFileMatcher(
  patterns: readonly string[] = DEFAULT_TEST_FILE_PATTERNS,
): TestFileMatcher {
  const regexes = patterns.map(globToRegExp);
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
