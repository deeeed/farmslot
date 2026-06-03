export interface DiffFileEntry {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  header: string;
  oldStart: number | null;
  newStart: number | null;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'meta';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export type DiffFileFilter = 'all' | 'source' | 'tests' | 'docs' | 'config';

export function parseUnifiedDiff(diffText: string): DiffFileEntry[] {
  const lines = diffText.replace(/\r\n?/g, '\n').split('\n');
  const files: Array<{ path: string; lines: string[] }> = [];
  let currentLines: string[] = [];
  let currentPath = '';

  const flush = () => {
    if (!currentLines.length) return;
    files.push({ path: currentPath || `diff-${files.length + 1}`, lines: currentLines });
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentLines = [line];
      const match = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
      currentPath = normalizeDiffPath(
        match?.[2] ?? match?.[1] ?? line.replace(/^diff --git\s+/, ''),
      );
      continue;
    }
    if (!currentLines.length && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      currentLines = [line];
      currentPath = normalizeDiffPath(line.replace(/^[-+]{3}\s+/, '').trim());
      continue;
    }
    if (currentLines.length) currentLines.push(line);
  }
  flush();

  return files.map(({ path, lines: fileLines }, index) => {
    const diff = fileLines.join('\n');
    const hunks = parseHunks(fileLines);
    const additions = hunks.reduce(
      (count, hunk) => count + hunk.lines.filter((line) => line.type === 'add').length,
      0,
    );
    const deletions = hunks.reduce(
      (count, hunk) => count + hunk.lines.filter((line) => line.type === 'del').length,
      0,
    );
    return {
      path: path || `diff-${index + 1}`,
      diff,
      additions,
      deletions,
      hunks,
    };
  });
}

function normalizeDiffPath(path: string): string {
  return path
    .replace(/^(a|b)\//, '')
    .replace(/^\/dev\/null$/, 'deleted')
    .trim();
}

function parseHunks(lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const pushMeta = (text: string) => {
    if (!current) {
      current = { header: 'File header', oldStart: null, newStart: null, lines: [] };
      hunks.push(current);
    }
    current.lines.push({ type: 'meta', text, oldLine: null, newLine: null });
  };

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      inHunk = true;
      current = {
        header: line,
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      };
      hunks.push(current);
      continue;
    }

    if (!current) {
      pushMeta(line);
      continue;
    }

    if (line.startsWith('+') && inHunk) {
      current.lines.push({ type: 'add', text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (line.startsWith('-') && inHunk) {
      current.lines.push({ type: 'del', text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (line.startsWith('\\')) {
      current.lines.push({ type: 'meta', text: line, oldLine: null, newLine: null });
    } else if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ ')))
    ) {
      current.lines.push({ type: 'meta', text: line, oldLine: null, newLine: null });
    } else {
      const text = line.startsWith(' ') ? line.slice(1) : line;
      current.lines.push({ type: 'context', text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return hunks;
}

export function filterDiffFiles(
  files: DiffFileEntry[],
  filter: DiffFileFilter,
  query: string,
): DiffFileEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  return files.filter((file) => {
    if (filter !== 'all' && fileCategory(file.path) !== filter) return false;
    if (!normalizedQuery) return true;
    return file.path.toLowerCase().includes(normalizedQuery);
  });
}

export function fileCategory(path: string): Exclude<DiffFileFilter, 'all'> {
  const lower = path.toLowerCase();
  if (/(__tests__|\.test\.|\.spec\.|\/test\/|\/tests\/)/.test(lower)) return 'tests';
  if (/\.(md|mdx|txt|rst)$/.test(lower) || lower.includes('/docs/')) return 'docs';
  if (/\.(json|ya?ml|toml|lock|config\.[jt]s|config\.mjs|plist|gradle|properties)$/.test(lower)) {
    return 'config';
  }
  return 'source';
}

export function diffArtifactCandidate(artifacts: Array<{ path: string; purpose?: string }>) {
  const ranked = artifacts
    .map((artifact) => ({ artifact, score: diffArtifactScore(artifact) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.artifact;
}

export function diffFocusedFilePathFromRequest(
  requestedPath: string | null | undefined,
  artifacts: Array<{ path: string; purpose?: string }>,
) {
  const normalizedPath = requestedPath?.trim() ?? '';
  if (!normalizedPath) return '';
  if (diffArtifactCandidate([{ path: normalizedPath }])) return '';
  if (artifacts.some((artifact) => artifact.path === normalizedPath)) return '';
  return normalizedPath;
}

function diffArtifactScore(artifact: { path: string; purpose?: string }): number {
  const lowerPath = artifact.path.toLowerCase();
  const lowerPurpose = artifact.purpose?.toLowerCase() ?? '';
  if (lowerPath === 'artifacts/diff.txt') return 100;
  if (lowerPath.endsWith('/diff.txt')) return 95;
  if (/\.(diff|patch)$/.test(lowerPath)) return 90;
  if (lowerPath.endsWith('.json')) return 0;
  if (lowerPurpose.includes('diff')) return 60;
  return 0;
}
