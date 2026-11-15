// From T3 Code packages/shared/src/markdownLinks.ts (b8c2cfad), up to parseMarkdownFileLink.
import { type FilePathPosition, parseFileUrlHref, splitFilePathPosition } from './fileLinks';
import { isWindowsAbsolutePath, stripSlashPrefixedWindowsDrive } from './path';

const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;

// Names may use any script (`線性代數/考試.pdf`) and routing punctuation (`posts.$id.tsx`,
// `(group)/[id]/+page.svelte`, `@scope/pkg`). The final segment is optional so an explicit
// folder link may end in `/` (`patches/`, `docs/My Folder/`). A bare name with no slash still fails.
const RELATIVE_FILE_PATH_PATTERN =
  /^(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()[\]-]+)*\/)+(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()[\]-]+)*(?::\d+){0,2})?$/u;

// No `@` here: `me@example.com` is an address, not a file.
const RELATIVE_FILE_NAME_PATTERN =
  /^[\p{L}\p{M}\p{N}._$+()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+()[\]-]+)*\.[\p{L}\p{M}\p{N}_-]+(?::\d+){0,2}$/u;

const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;

const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;

const INLINE_CODE_DISQUALIFIER_PATTERN = /[\s`]/;

const PATH_SEPARATOR_PATTERN = /[\\/]/;
// Agents shorten long paths with a `...` or `…` segment, which no file chip can open.
const ELIDED_PATH_SEGMENT_PATTERN = /(?:^|[\\/])(?:\.{3,}|…)(?:[\\/]|$)/;

const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9_-]+$/;
const VERSION_SUFFIX_PATTERN = /\d\.\d[^.]*$/;
const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;

const POSIX_FILE_ROOT_PREFIXES = [
  '/Users/',
  '/home/',
  '/tmp/',
  '/var/',
  '/etc/',
  '/opt/',
  '/mnt/',
  '/Volumes/',
  '/private/',
  '/root/',
  '/usr/',
  '/bin/',
  '/sbin/',
  '/lib/',
  '/lib64/',
  '/srv/',
  '/dev/',
  '/proc/',
  '/sys/',
  '/run/',
  '/boot/',
  '/media/',
  '/workspace/',
  '/workspaces/',
] as const;

const EXTENSIONLESS_FILE_NAMES = new Set([
  'Makefile',
  'makefile',
  'GNUmakefile',
  'Dockerfile',
  'Containerfile',
  'Justfile',
  'justfile',
  'Rakefile',
  'Gemfile',
  'Procfile',
  'Brewfile',
  'Caddyfile',
  'Vagrantfile',
  'Jenkinsfile',
  'Podfile',
  'Fastfile',
  'BUILD',
  'WORKSPACE',
  'LICENSE',
  'LICENCE',
  'COPYING',
  'NOTICE',
  'AUTHORS',
  'CONTRIBUTORS',
  'CHANGELOG',
  'README',
  'CODEOWNERS',
]);

const SINGLE_LABEL_HOSTNAMES = new Set(['localhost']);

const GENERIC_HOSTNAME_TLDS = new Set([
  'com',
  'net',
  'org',
  'io',
  'dev',
  'app',
  'ai',
  'co',
  'edu',
  'gov',
  'mil',
  'info',
  'biz',
  'xyz',
  'me',
  'tv',
  'gg',
  'chat',
  'cloud',
  'site',
  'online',
  'tech',
  'store',
  'link',
]);

const COUNTRY_HOSTNAME_TLDS = new Set([
  'uk',
  'de',
  'fr',
  'nl',
  'se',
  'no',
  'fi',
  'dk',
  'pl',
  'ch',
  'at',
  'be',
  'es',
  'it',
  'pt',
  'eu',
  'us',
  'ca',
  'au',
  'nz',
  'jp',
  'kr',
  'cn',
  'br',
  'ru',
  'mx',
  'ie',
  'cz',
  'tr',
  'sg',
  'hk',
  // C++ sources end in `.cc`, so `allocator.cc:217` names a file, not a host and port.
  'cc',
]);

function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith('.')) return false;
  const lowered = segment.toLowerCase();
  if (SINGLE_LABEL_HOSTNAMES.has(lowered)) return true;
  if (NUMERIC_DOTTED_PATTERN.test(segment)) return true;
  const labels = lowered.split('.');
  const lastLabel = labels.at(-1);
  if (labels.length < 2 || lastLabel === undefined) return false;
  if (GENERIC_HOSTNAME_TLDS.has(lastLabel)) return true;
  return !hasPosition && COUNTRY_HOSTNAME_TLDS.has(lastLabel);
}

export function inlineCodeFilePathCandidate(codeText: string): string | null {
  const trimmed = codeText.trim();
  if (trimmed.length === 0 || INLINE_CODE_DISQUALIFIER_PATTERN.test(trimmed)) return null;

  const candidate = isWindowsAbsolutePath(trimmed) ? trimmed : trimmed.replaceAll('\\', '/');
  const hasPosition = POSITION_SUFFIX_PATTERN.test(candidate);
  if (!hasPosition && !PATH_SEPARATOR_PATTERN.test(candidate)) return null;
  if (ELIDED_PATH_SEGMENT_PATTERN.test(candidate.replace(POSITION_SUFFIX_PATTERN, ''))) return null;

  const hasExplicitPathShape =
    RELATIVE_PATH_PREFIX_PATTERN.test(candidate) ||
    candidate.startsWith('/') ||
    isWindowsAbsolutePath(candidate);
  if (!hasExplicitPathShape) {
    const withoutPosition = candidate.replace(POSITION_SUFFIX_PATTERN, '');
    // Markdown destinations accept `patches/`. Inline code still needs a
    // file-shaped final segment, so a trailing slash stays plain code.
    if (withoutPosition.endsWith('/')) return null;
    const firstSegment = withoutPosition.split('/')[0] ?? withoutPosition;
    if (looksLikeHostname(firstSegment, hasPosition)) return null;
    const basename =
      withoutPosition
        .replace(/[/\\]+$/, '')
        .split(/[\\/]/)
        .at(-1) ?? '';
    if (VERSION_SUFFIX_PATTERN.test(basename)) return null;
    if (!hasPosition && !FILE_EXTENSION_PATTERN.test(basename)) return null;
  }
  return candidate;
}

export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A lone `%` in an authored path is literal text, not an encoding to undo.
    return value;
  }
}

export function normalizeMarkdownLinkDestination(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
}

export function splitMarkdownLinkSearchAndHash(value: string): {
  readonly path: string;
  readonly hash: string;
} {
  const hashIndex = value.indexOf('#');
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : '';
  const queryIndex = pathWithSearch.indexOf('?');
  return {
    path: queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch,
    hash,
  };
}

/**
 * The decoded path a markdown destination names on the host, before any workspace resolution, or
 * null for a `file:` URL that does not parse. Clients and the guest media route both read it here.
 */
export function markdownDestinationHostPath(source: string): string | null {
  if (/^file:/i.test(source)) {
    const target = parseFileUrlHref(source);
    return target === null
      ? null
      : stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(target.path));
  }
  return stripSlashPrefixedWindowsDrive(
    safeDecodeURIComponent(splitMarkdownLinkSearchAndHash(source).path),
  );
}

export function isMarkdownFileLinkLabel(label: string, href: string): boolean {
  const destination = parseMarkdownFileLink(href);
  if (!destination) return false;
  const normalize = (path: string) =>
    path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const labelPosition = splitFilePathPosition(label.trim());
  if (
    (labelPosition.line !== undefined && labelPosition.line !== destination.line) ||
    (labelPosition.column !== undefined && labelPosition.column !== destination.column)
  ) {
    return false;
  }
  let labelPath = normalize(labelPosition.path);
  let destinationPath = normalize(destination.path);
  if (labelPath.length === 0) return true;
  if (isWindowsAbsolutePath(destination.path)) {
    labelPath = labelPath.toLowerCase();
    destinationPath = destinationPath.toLowerCase();
  }
  return destinationPath === labelPath || destinationPath.endsWith(`/${labelPath}`);
}

export function isRelativeFilePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith('/') && !isWindowsAbsolutePath(path))
  );
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return EXTENSIONLESS_FILE_NAMES.has(basename) || FILE_EXTENSION_PATTERN.test(basename);
}

function looksLikeFilePath(path: string, authoredPath: string): boolean {
  if (isWindowsAbsolutePath(path) || RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith('/')) return looksLikePosixFilesystemPath(authoredPath);
  if (EXTENSIONLESS_FILE_NAMES.has(path)) return true;
  return RELATIVE_FILE_PATH_PATTERN.test(authoredPath) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function hasExternalScheme(path: string): boolean {
  if (isWindowsAbsolutePath(path)) return false;
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? '';
  if (rest.startsWith('//')) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

export function parseMarkdownFileLink(href: string): FilePathPosition | null {
  const normalized = normalizeMarkdownLinkDestination(href);
  if (normalized.length === 0 || normalized.startsWith('#') || normalized.startsWith('//')) {
    return null;
  }

  const source =
    (normalized.toLowerCase().startsWith('file:') ? parseFileUrlHref(normalized) : null) ??
    splitMarkdownLinkSearchAndHash(normalized);
  const path = stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(source.path.trim()));
  const hash = safeDecodeURIComponent(source.hash.trim());
  if (path.length === 0 || hasExternalScheme(path)) return null;

  const position = splitFilePathPosition(path, hash);
  return looksLikeFilePath(position.path, path) ? position : null;
}
