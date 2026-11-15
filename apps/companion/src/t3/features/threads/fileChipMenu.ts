// From T3 Code apps/mobile/src/features/threads/fileChipMenu.ts (b8c2cfad). Companion has no
// media share route, so the menu offers copying and the file viewer only.
import { resolveMarkdownLinkPresentation } from '../../lib/markdownLinks';
import type { MarkdownFileContextMenu } from '../../native/SelectableMarkdownText.types';
import {
  isAbsolutePath,
  resolveFileLinkPath,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from '../files/filePath';

export interface FileChipTarget {
  readonly fullPath?: string;
  readonly relativePath?: string;
  readonly line?: number;
  readonly column?: number;
}

export function fileChipClipboardPath(
  target: FileChipTarget,
  action: 'copy-full-path' | 'copy-relative-path',
): string | undefined {
  return action === 'copy-full-path' ? target.fullPath : target.relativePath;
}

export function resolveFileChipTarget(
  href: string,
  workspaceRoot: string | null | undefined,
): FileChipTarget | null {
  const presentation = resolveMarkdownLinkPresentation(href);
  if (presentation.kind !== 'file') return null;
  const path = resolveFileLinkPath(workspaceRoot, presentation.path);
  if (path === null) return null;
  const relativePath = resolveWorkspaceRelativeFilePath(workspaceRoot, path);
  const fullPath = isAbsolutePath(path)
    ? path
    : workspaceRoot && relativePath
      ? resolveWorkspaceFilePath(workspaceRoot, relativePath)
      : undefined;
  if (!fullPath && !relativePath) return null;
  return {
    ...(fullPath ? { fullPath } : {}),
    ...(relativePath ? { relativePath } : {}),
    ...(presentation.line ? { line: presentation.line } : {}),
    ...(presentation.column ? { column: presentation.column } : {}),
  };
}

export function fileChipMenu(target: FileChipTarget): MarkdownFileContextMenu {
  return {
    title: target.fullPath ?? target.relativePath ?? '',
    actions: [
      ...(target.fullPath ? [{ id: 'copy-full-path', title: 'Copy full path' }] : []),
      ...(target.relativePath ? [{ id: 'copy-relative-path', title: 'Copy relative path' }] : []),
      // The gateway reads files relative to the session's folder.
      { id: 'open-file', title: 'Open in file viewer', disabled: !target.relativePath },
    ],
  };
}
