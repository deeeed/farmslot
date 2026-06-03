import path from 'node:path';

import { harnessRoot } from '../projects/harness-root.js';

const DEFAULT_ALLOW_EXTENSIONS = [
  '.astro',
  '.bash',
  '.c',
  '.cc',
  '.cfg',
  '.cljs',
  '.cmake',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.cxx',
  '.dart',
  '.dockerfile',
  '.ejs',
  '.elm',
  '.erb',
  '.ex',
  '.exs',
  '.fs',
  '.go',
  '.graphql',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.kt',
  '.kts',
  '.less',
  '.lua',
  '.m',
  '.mm',
  '.md',
  '.mdx',
  '.mjs',
  '.php',
  '.pl',
  '.plist',
  '.proto',
  '.py',
  '.rake',
  '.rb',
  '.rs',
  '.sass',
  '.scala',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
] as const;

const DEFAULT_ALLOW_BASENAMES = [
  'Dockerfile',
  'Gemfile',
  'Makefile',
  'Podfile',
  'Rakefile',
  'Brewfile',
  'Appfile',
  'Fastfile',
  'Guardfile',
  'Procfile',
] as const;

const DEFAULT_BLOCK_BASENAMES = [
  'Cargo.lock',
  'Gemfile.lock',
  'package-lock.json',
  'Podfile.lock',
  'pnpm-lock.yaml',
  'yarn.lock',
] as const;

export const SOURCE_DIFF_FILTER_CUSTOM_ENTRY_LIMIT = 256;
export const SOURCE_DIFF_FILTER_ENTRY_CHAR_LIMIT = 256;
export const SOURCE_DIFF_FILTER_PATHSPEC_LIMIT = 256;
export const SOURCE_DIFF_FILTER_PATHSPEC_CHAR_BUDGET = 60_000;

export interface SourceDiffFilterConfig {
  useDefaults?: boolean;
  allowlist?: {
    extensions?: string[];
    basenames?: string[];
    patterns?: string[];
  };
  blocklist?: {
    extensions?: string[];
    basenames?: string[];
    patterns?: string[];
  };
}

export interface SourceDiffFilter {
  allowAll: boolean;
  allowExtensions: Set<string>;
  allowBasenames: Set<string>;
  allowPatterns: string[];
  allowRegexes: RegExp[];
  blockExtensions: Set<string>;
  blockBasenames: Set<string>;
  blockPatterns: string[];
  blockRegexes: RegExp[];
  invalidPatterns: string[];
}

function normalizeExtension(extension: string): string | null {
  const trimmed = extension.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function cleanList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function capCustomEntries(entries: string[], label: string): string[] {
  const kept: string[] = [];
  let droppedForLength = 0;
  for (const entry of entries) {
    if (entry.length > SOURCE_DIFF_FILTER_ENTRY_CHAR_LIMIT) {
      droppedForLength += 1;
      continue;
    }
    kept.push(entry);
    if (kept.length === SOURCE_DIFF_FILTER_CUSTOM_ENTRY_LIMIT) break;
  }
  const droppedForCount = Math.max(0, entries.length - kept.length - droppedForLength);
  if (droppedForLength > 0 || droppedForCount > 0) {
    console.warn(
      `[source-diff-filter] capped ${label}: kept=${kept.length} droppedForCount=${droppedForCount} droppedForLength=${droppedForLength}`,
    );
  }
  return kept;
}

function optionalListConfig(value: unknown): string[] | undefined {
  const entries = cleanList(value);
  return entries.length > 0 ? entries : undefined;
}

function readListConfig(raw: unknown): SourceDiffFilterConfig['allowlist'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  return {
    extensions: optionalListConfig(capCustomEntries(cleanList(rec.extensions), 'extensions')),
    basenames: optionalListConfig(capCustomEntries(cleanList(rec.basenames), 'basenames')),
    patterns: optionalListConfig(capCustomEntries(cleanList(rec.patterns), 'patterns')),
  };
}

export function readSourceDiffFilterConfig(raw: unknown): SourceDiffFilterConfig {
  if (!raw || typeof raw !== 'object') return {};
  const rec = raw as Record<string, unknown>;
  return {
    useDefaults:
      typeof rec.useDefaults === 'boolean'
        ? rec.useDefaults
        : typeof rec.use_defaults === 'boolean'
          ? rec.use_defaults
          : undefined,
    allowlist: readListConfig(rec.allowlist),
    blocklist: readListConfig(rec.blocklist),
  };
}

// Supports the simple project-config glob subset used for diff filtering: *, **, and ?.
// Character classes/extglobs are intentionally not implemented; use explicit
// allowlist/blocklist entries when a path needs that precision.
interface CompiledGlob {
  regex: RegExp;
  invalid: boolean;
  pattern: string;
}

function compileGlob(pattern: string): CompiledGlob {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (/[\[\]]/.test(normalized)) {
    console.warn(
      `[source-diff-filter] glob pattern "${normalized}" contains unsupported character-class syntax; pattern will not match`,
    );
    return { regex: new RegExp('(?!)'), invalid: true, pattern: normalized };
  }
  let source = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (char === '*' && next === '*') {
      // `**/X` matches X at any depth, including root: emit (?:.*/)?
      // so `**/*.ts` matches both `foo.ts` and `dir/foo.ts`. Git's
      // :(glob)**/X pathspec already includes root files, so the JS
      // matcher must agree to keep parseGitNumstat from filtering them
      // back out and producing spurious no-source-diff results.
      if (normalized[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  source += '$';
  try {
    return { regex: new RegExp(source, 'i'), invalid: false, pattern: normalized };
  } catch (err) {
    console.warn(
      `[source-diff-filter] invalid glob pattern "${normalized}": ${(err as Error).message.slice(0, 200)}`,
    );
    // Deliberately match nothing when a configured glob cannot compile.
    return { regex: new RegExp('(?!)'), invalid: true, pattern: normalized };
  }
}

function normalizeDiffPathForSourceCheck(filePath: string): string {
  return filePath
    .replace(/\{[^{}]* => ([^{}]*)\}/g, '$1')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^"|"$/g, '');
}

function buildSet(
  entries: readonly string[],
  normalize: (entry: string) => string | null = (entry) => entry.trim() || null,
): Set<string> {
  return new Set(
    entries.flatMap((entry) => {
      const normalized = normalize(entry);
      return normalized ? [normalized] : [];
    }),
  );
}

export function buildSourceDiffFilter(config: SourceDiffFilterConfig = {}): SourceDiffFilter {
  const useDefaults = config.useDefaults !== false;
  const customAllowExtensions = capCustomEntries(
    cleanList(config.allowlist?.extensions),
    'allowlist.extensions',
  );
  const customAllowBasenames = capCustomEntries(
    cleanList(config.allowlist?.basenames),
    'allowlist.basenames',
  );
  const customAllowPatterns = capCustomEntries(
    cleanList(config.allowlist?.patterns),
    'allowlist.patterns',
  );
  const allowAll =
    !useDefaults &&
    customAllowExtensions.length === 0 &&
    customAllowBasenames.length === 0 &&
    customAllowPatterns.length === 0;
  const allowExtensions = buildSet(
    [...(useDefaults ? DEFAULT_ALLOW_EXTENSIONS : []), ...customAllowExtensions],
    normalizeExtension,
  );
  const allowBasenames = buildSet([
    ...(useDefaults ? DEFAULT_ALLOW_BASENAMES : []),
    ...customAllowBasenames,
  ]);
  const blockExtensions = buildSet(
    [...capCustomEntries(cleanList(config.blocklist?.extensions), 'blocklist.extensions')],
    normalizeExtension,
  );
  const blockBasenames = buildSet([
    ...(useDefaults ? DEFAULT_BLOCK_BASENAMES : []),
    ...capCustomEntries(cleanList(config.blocklist?.basenames), 'blocklist.basenames'),
  ]);
  const compiledAllow = customAllowPatterns.map(compileGlob);
  const compiledBlock = capCustomEntries(
    // Always block the configured harness injection root (default temp/agentic/recipe-harness),
    // so harness overlay files are excluded from diff analysis even under a custom root.
    [`${harnessRoot()}/**`, ...cleanList(config.blocklist?.patterns)],
    'blocklist.patterns',
  ).map(compileGlob);
  // Drop invalid patterns from the emitted pattern lists so they cannot leak
  // into git pathspecs. Git supports bracket character classes natively, so an
  // unsupported (in our matcher) pattern like `src/[ab].ts` would silently
  // include/exclude real source paths in contribution-diff capture even though
  // the JS-side `(?!)` regex matches nothing.
  const validAllow = compiledAllow.filter((entry) => !entry.invalid);
  const validBlock = compiledBlock.filter((entry) => !entry.invalid);
  const invalidPatterns = [...compiledAllow, ...compiledBlock]
    .filter((entry) => entry.invalid)
    .map((entry) => entry.pattern);
  return {
    allowAll,
    allowExtensions,
    allowBasenames,
    allowPatterns: validAllow.map((entry) => entry.pattern),
    allowRegexes: validAllow.map((entry) => entry.regex),
    blockExtensions,
    blockBasenames,
    blockPatterns: validBlock.map((entry) => entry.pattern),
    blockRegexes: validBlock.map((entry) => entry.regex),
    invalidPatterns,
  };
}

export const DEFAULT_SOURCE_DIFF_FILTER = buildSourceDiffFilter();

export function isSourceCodePath(
  filePath: string,
  filter: SourceDiffFilter = DEFAULT_SOURCE_DIFF_FILTER,
): boolean {
  const normalized = normalizeDiffPathForSourceCheck(filePath);
  const basename = path.basename(normalized);
  const extension = path.extname(normalized).toLowerCase();
  const blocked =
    filter.blockBasenames.has(basename) ||
    filter.blockExtensions.has(extension) ||
    filter.blockRegexes.some((regex) => regex.test(normalized));
  if (blocked) return false;
  return (
    filter.allowBasenames.has(basename) ||
    filter.allowAll ||
    filter.allowExtensions.has(extension) ||
    filter.allowRegexes.some((regex) => regex.test(normalized))
  );
}

function capPathspecs(
  pathspecs: string[],
  reserve: { count?: number; chars?: number } = {},
): string[] {
  const kept: string[] = [];
  let totalChars = 0;
  const countLimit = Math.max(0, SOURCE_DIFF_FILTER_PATHSPEC_LIMIT - (reserve.count ?? 0));
  const charLimit = Math.max(0, SOURCE_DIFF_FILTER_PATHSPEC_CHAR_BUDGET - (reserve.chars ?? 0));
  for (const spec of pathspecs) {
    const nextChars = totalChars + spec.length;
    if (kept.length >= countLimit || nextChars > charLimit) break;
    kept.push(spec);
    totalChars = nextChars;
  }
  if (kept.length < pathspecs.length) {
    console.warn(
      `[source-diff-filter] capped git pathspecs: kept=${kept.length} dropped=${pathspecs.length - kept.length} charBudget=${charLimit}`,
    );
  }
  return kept;
}

function extensionPathspec(extension: string, exclude = false): string {
  return `:(${exclude ? 'exclude,' : ''}icase,glob)**/*${extension}`;
}

function basenamePathspecs(basename: string, exclude = false): string[] {
  const prefix = exclude ? ':(exclude,icase' : ':(icase';
  return [`${prefix})${basename}`, `${prefix},glob)**/${basename}`];
}

function patternPathspec(pattern: string, exclude = false): string {
  return `:(${exclude ? 'exclude,' : ''}icase,glob)${pattern}`;
}

export function sourceCodeGitPathspecs(
  filter: SourceDiffFilter = DEFAULT_SOURCE_DIFF_FILTER,
): string[] {
  if (
    !filter.allowAll &&
    filter.allowExtensions.size === 0 &&
    filter.allowBasenames.size === 0 &&
    filter.allowPatterns.length === 0
  ) {
    return [];
  }
  const blockSpecs = [
    ...[...filter.blockExtensions].map((extension) => extensionPathspec(extension, true)),
    ...[...filter.blockBasenames].flatMap((basename) => basenamePathspecs(basename, true)),
    ...filter.blockPatterns.map((pattern) => patternPathspec(pattern, true)),
  ];
  const allowSpecs = [
    ...(filter.allowAll ? [':(glob)**'] : []),
    ...[...filter.allowExtensions].map((extension) => extensionPathspec(extension)),
    ...[...filter.allowBasenames].flatMap((basename) => basenamePathspecs(basename)),
    ...filter.allowPatterns.map((pattern) => patternPathspec(pattern)),
  ];
  const firstAllowSpec = allowSpecs[0];
  const reservedForAllow = firstAllowSpec ? { count: 1, chars: firstAllowSpec.length } : {};
  const cappedBlockSpecs = capPathspecs(blockSpecs, reservedForAllow);
  const result = firstAllowSpec
    ? capPathspecs([...cappedBlockSpecs, firstAllowSpec, ...allowSpecs.slice(1)])
    : capPathspecs(cappedBlockSpecs);
  if (allowSpecs.length > 0 && !result.some((spec) => !spec.startsWith(':(exclude,'))) {
    console.warn(
      '[source-diff-filter] capped git pathspecs before any allowlist pathspec could be emitted; using first allowlist pathspec only',
    );
    return [allowSpecs[0]];
  }
  return result;
}

export function parseNameOnlySourcePaths(
  stdout: string,
  filter: SourceDiffFilter = DEFAULT_SOURCE_DIFF_FILTER,
): string[] {
  return stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) => isSourceCodePath(filePath, filter));
}
