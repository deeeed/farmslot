// Splits unified diff text (`git diff`, `git show`, `diff -u`) into per-file
// entries. Hunk lengths are counted, so a removed line that starts with `--`
// never reads as a new file header.

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
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

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
  let oldLeft = 0;
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
    if (oldLeft > 0 || newLeft > 0) {
      body.push(line);
      if (line.startsWith('+')) {
        newLeft -= 1;
        additions += 1;
      } else if (line.startsWith('-')) {
        oldLeft -= 1;
        deletions += 1;
      } else if (!line.startsWith('\\')) {
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      start(line.match(GIT_HEADER)?.[2] ?? line.replace(/^diff --git\s+/, ''));
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
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    }
    body.push(line);
  }
  flush();
  return { preamble: preamble.join('\n'), files };
}

export function parseUnifiedDiff(diffText: string): DiffFileEntry[] {
  return splitUnifiedDiff(diffText).files;
}
