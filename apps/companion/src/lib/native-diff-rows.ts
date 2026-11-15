import { workspaceRelativeFilePath } from '../t3/shared/path';

import { type DiffFileEntry, parseUnifiedDiff } from './diff';

/** One row of T3's native diff view (`NativeReviewDiffRow` in src/t3/features/diffs). */
export interface NativeDiffRow {
  readonly kind: 'file' | 'hunk' | 'line';
  readonly id: string;
  readonly fileId: string;
  readonly filePath?: string;
  readonly changeType?: 'modified' | 'new' | 'deleted';
  readonly additions?: number;
  readonly deletions?: number;
  readonly text?: string;
  readonly content?: string;
  readonly change?: 'context' | 'add' | 'delete';
  readonly oldLineNumber?: number | null;
  readonly newLineNumber?: number | null;
}

export interface NativeDiffToken {
  readonly content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
}

/** Highlights one side's text into lines of tokens; null when the language has no lexer. */
export type NativeDiffHighlighter = (
  code: string,
  path: string,
) => ReadonlyArray<ReadonlyArray<NativeDiffToken>> | null;

export interface NativeDiffDocument {
  readonly rows: readonly NativeDiffRow[];
  readonly files: readonly DiffFileEntry[];
  readonly additions: number;
  readonly deletions: number;
}

function changeType(file: DiffFileEntry): NativeDiffRow['changeType'] {
  if (/^new file mode/m.test(file.diff) || /^--- \/dev\/null$/m.test(file.diff)) return 'new';
  if (/^deleted file mode/m.test(file.diff) || /^\+\+\+ \/dev\/null$/m.test(file.diff))
    return 'deleted';
  return 'modified';
}

/**
 * Rows for the native diff view: a header per file, then each hunk's header and lines. Paths
 * inside `root` show relative to it.
 */
export function nativeDiffDocument(diffText: string, root?: string): NativeDiffDocument {
  // The trailing newline would otherwise parse as one more context line.
  const files = parseUnifiedDiff(diffText.replace(/\n+$/, ''));
  const rows: NativeDiffRow[] = [];
  files.forEach((file, fileIndex) => {
    const fileId = `${fileIndex}:${file.path}`;
    rows.push({
      kind: 'file',
      id: `${fileId}:file`,
      fileId,
      filePath:
        (file.path.startsWith('/') && workspaceRelativeFilePath(file.path, root)) || file.path,
      changeType: changeType(file),
      additions: file.additions,
      deletions: file.deletions,
    });
    file.hunks.forEach((hunk, hunkIndex) => {
      if (hunk.oldStart === null) return;
      rows.push({ kind: 'hunk', id: `${fileId}:${hunkIndex}`, fileId, text: hunk.header });
      hunk.lines.forEach((line, lineIndex) => {
        if (line.type === 'meta') return;
        rows.push({
          kind: 'line',
          id: `${fileId}:${hunkIndex}:${lineIndex}`,
          fileId,
          content: line.text,
          change: line.type === 'add' ? 'add' : line.type === 'del' ? 'delete' : 'context',
          oldLineNumber: line.oldLine,
          newLineNumber: line.newLine,
        });
      });
    });
  });
  return {
    rows,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

/**
 * Tokens per line row. Each file's old side (context and deletions) and new side (context and
 * additions) are highlighted as one text each, so a line keeps the lexer state of the lines above
 * it within its hunks.
 */
export function nativeDiffTokens(
  document: NativeDiffDocument,
  highlight: NativeDiffHighlighter,
): Record<string, readonly NativeDiffToken[]> {
  const tokens: Record<string, readonly NativeDiffToken[]> = {};
  const byFile = new Map<string, NativeDiffRow[]>();
  for (const row of document.rows) {
    if (row.kind !== 'line') continue;
    byFile.set(row.fileId, [...(byFile.get(row.fileId) ?? []), row]);
  }
  for (const [fileId, lines] of byFile) {
    const path = document.rows.find(
      (row) => row.fileId === fileId && row.kind === 'file',
    )?.filePath;
    if (!path) continue;
    for (const side of ['old', 'new'] as const) {
      const sideRows = lines.filter((row) => row.change !== (side === 'old' ? 'add' : 'delete'));
      const highlighted = highlight(sideRows.map((row) => row.content ?? '').join('\n'), path);
      if (!highlighted) continue;
      sideRows.forEach((row, index) => {
        // Context lines appear on both sides with the same text; the new side's tokens win.
        if (side === 'old' && row.change === 'context') return;
        const line = highlighted[index];
        if (line) tokens[row.id] = line;
      });
    }
  }
  return tokens;
}
