// One glob-to-regex compiler for the two path filters that used to carry their
// own: the gateway's source-diff filter (git `:(glob)` pathspec semantics) and
// the diff-view test-file matcher (gitignore-like segment rules). The subset
// is `*`, `**` and `?`; character classes are rejected because git would honour
// them while a JS matcher that ignored them would silently disagree.

export type GlobAnchoring =
  /**
   * Always anchored at the repo root, mirroring git `:(glob)` pathspecs:
   * `*.ts` matches only root files, `src/**` matches below `src/`.
   */
  | 'anchored'
  /**
   * gitignore-like: a pattern without a slash names a path segment anywhere
   * (file or directory, plus everything below a matching directory), a
   * trailing slash names a directory anywhere, an inner slash anchors at the
   * root unless the pattern starts with `**` and a slash.
   */
  | 'segment';

export interface GlobCompileOptions {
  anchoring: GlobAnchoring;
  caseSensitive: boolean;
}

export interface CompiledGlob {
  /** Normalized pattern: forward slashes, no `./` prefix, double-star runs collapsed. */
  pattern: string;
  /** Matches nothing when `invalid` is true. */
  regex: RegExp;
  invalid: boolean;
  /** Why the pattern was rejected; undefined when valid. */
  reason?: string;
}

const MATCH_NOTHING = /(?!)/;

/** Forward slashes, no leading `./`, and each run of double-star segments collapsed to one. */
export function normalizeGlobPattern(pattern: string): string {
  return (
    pattern
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      // Runs of `**/` mean the same as one; compiling each into its own optional
      // group makes a non-match backtrack exponentially.
      .replace(/(?:\*\*\/)+/g, '**/')
  );
}

/** Number of double-star runs after normalization (each becomes an unbounded group). */
export function globDoubleStarRuns(pattern: string): number {
  return (normalizeGlobPattern(pattern).match(/\*\*/g) ?? []).length;
}

export function compileGlob(pattern: string, options: GlobCompileOptions): CompiledGlob {
  let glob = normalizeGlobPattern(pattern);
  if (options.anchoring === 'segment') glob = glob.replace(/^\/+/, '');
  if (/[[\]]/.test(glob)) {
    return {
      pattern: glob,
      regex: MATCH_NOTHING,
      invalid: true,
      reason: 'contains unsupported character-class syntax; list the paths explicitly instead',
    };
  }
  const directoryOnly = options.anchoring === 'segment' && glob.endsWith('/');
  if (directoryOnly) glob = glob.replace(/\/+$/, '');
  const segmentAnywhere = options.anchoring === 'segment' && !glob.includes('/');

  let body = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      const atSegmentStart = i === 0 || glob[i - 1] === '/';
      if (atSegmentStart && glob[i + 2] === '/') {
        // `**/` — zero or more whole directories, root included, so `**/*.ts`
        // matches both `foo.ts` and `dir/foo.ts` (git's `:(glob)**/X` agrees).
        body += '(?:.*/)?';
        i += 2;
      } else {
        body += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      body += '[^/]*';
    } else if (ch === '?') {
      body += '[^/]';
    } else if ('.+^${}()|'.includes(ch)) {
      body += `\\${ch}`;
    } else {
      body += ch;
    }
  }
  const prefix = segmentAnywhere ? '(?:.*/)?' : '';
  // A segment pattern also matches everything below a directory of that
  // name; a directory-only pattern matches only what lies below it.
  const suffix = directoryOnly ? '/.*' : segmentAnywhere ? '(?:/.*)?' : '';
  try {
    return {
      pattern: glob,
      regex: new RegExp(`^${prefix}${body}${suffix}$`, options.caseSensitive ? '' : 'i'),
      invalid: false,
    };
  } catch (err) {
    return {
      pattern: glob,
      regex: MATCH_NOTHING,
      invalid: true,
      reason: (err as Error).message.slice(0, 200),
    };
  }
}
