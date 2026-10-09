// Splits unified diff text (`git diff`, `git show`, `diff -u`, combined
// `diff --cc`) into per-file entries. Hunk lengths are counted, so a removed
// line that starts with `--` never reads as a new file header.

export interface DiffFileEntry {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
}

export interface UnifiedDiffSplit {
  /** Text before the first file (a commit header from `git show`), kept verbatim. */
  preamble: string;
  files: DiffFileEntry[];
}

// git's default a/ b/ prefixes plus the diff.mnemonicPrefix ones (c/ w/ i/ o/).
const GIT_HEADER = /^diff --git [abciow]\/(.*?) [abciow]\/(.*)$/;
// `@@ -a,b +c,d @@`, or `@@@ -a,b -c,d +e,f @@@` for a combined diff (one `-`
// range and one prefix column per parent).
const HUNK_HEADER = /^(@{2,}) ((?:-\d+(?:,\d+)? )+)\+\d+(?:,(\d+))? \1/;
const COMBINED_HEADER = /^diff --(?:cc|combined) (.*)$/;

/** Line count of a hunk range: `12,4` → 4, a bare `12` → 1. */
function rangeLength(range: string | undefined): number {
  return range === undefined ? 1 : Number(range);
}

/** Path from a `--- ` / `+++ ` header: prefix and `diff -u` timestamp dropped. */
function headerPath(line: string): string {
  return line
    .slice(4)
    .replace(/\t.*$/, '')
    .replace(/^[abciow]\//, '')
    .trim();
}

export function splitUnifiedDiff(diffText: string): UnifiedDiffSplit {
  const lines = diffText.split('\n');
  const preamble: string[] = [];
  const files: DiffFileEntry[] = [];
  let path: string | null = null;
  let body: string[] = [];
  let additions = 0;
  let deletions = 0;
  let hasFileHeader = false;
  // Lines still to read in the current hunk, per parent and for the result.
  let parentsLeft: number[] = [];
  let newLeft = 0;

  const flush = () => {
    if (path === null) return;
    files.push({
      path: path || `diff-${files.length + 1}`,
      diff: body.join('\n'),
      additions,
      deletions,
    });
  };
  const start = (nextPath: string) => {
    flush();
    path = nextPath;
    body = [];
    additions = 0;
    deletions = 0;
    hasFileHeader = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (newLeft > 0 || parentsLeft.some((left) => left > 0)) {
      body.push(line);
      if (line.startsWith('\\')) continue;
      // One column per parent. A removed line (`-` in some column) is only in
      // the parents marked `-`; a result line is in every parent not marked `+`.
      const columns = line.slice(0, parentsLeft.length);
      const removed = columns.includes('-');
      parentsLeft = parentsLeft.map((left, column) =>
        (removed ? columns[column] === '-' : columns[column] !== '+') ? left - 1 : left,
      );
      if (removed) {
        deletions += 1;
      } else {
        newLeft -= 1;
        if (columns.includes('+')) additions += 1;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      start(line.match(GIT_HEADER)?.[2] ?? line.replace(/^diff --git\s+/, ''));
      body.push(line);
      continue;
    }
    const combined = line.match(COMBINED_HEADER);
    if (combined) {
      start(combined[1]);
      body.push(line);
      continue;
    }
    const next = lines[index + 1];
    if (line.startsWith('--- ') && next?.startsWith('+++ ')) {
      if (path === null || hasFileHeader) {
        const newPath = headerPath(next);
        start(newPath === '/dev/null' ? headerPath(line) : newPath);
      }
      hasFileHeader = true;
      body.push(line, next);
      index += 1;
      continue;
    }
    if (path === null) {
      preamble.push(line);
      continue;
    }
    const hunk = line.match(HUNK_HEADER);
    if (hunk) {
      parentsLeft = [...hunk[2].matchAll(/-\d+(?:,(\d+))?/g)].map((range) => rangeLength(range[1]));
      newLeft = rangeLength(hunk[3]);
    }
    body.push(line);
  }
  flush();
  return { preamble: preamble.join('\n'), files };
}

export function parseUnifiedDiff(diffText: string): DiffFileEntry[] {
  return splitUnifiedDiff(diffText).files;
}
