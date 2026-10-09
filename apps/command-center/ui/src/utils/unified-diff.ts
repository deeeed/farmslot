// Splits unified diff text (a `git diff` artifact) into per-file entries.

export interface DiffFileEntry {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
}

export function parseUnifiedDiff(diffText: string): DiffFileEntry[] {
  const lines = diffText.split('\n');
  const files: DiffFileEntry[] = [];
  let current: string[] = [];
  let currentPath = '';
  const flush = () => {
    if (!current.length) return;
    let additions = 0;
    let deletions = 0;
    for (const line of current) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
    files.push({
      path: currentPath || `diff-${files.length + 1}`,
      diff: current.join('\n'),
      additions,
      deletions,
    });
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = [line];
      const match = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
      currentPath = match?.[2] ?? match?.[1] ?? line.replace(/^diff --git\s+/, '');
      continue;
    }
    if (!current.length && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      current = [line];
      currentPath = line.replace(/^[-+]{3}\s+[ab]\//, '').trim();
      continue;
    }
    if (current.length) current.push(line);
  }
  flush();
  return files;
}
