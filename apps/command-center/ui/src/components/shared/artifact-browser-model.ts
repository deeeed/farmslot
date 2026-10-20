import type { ArtifactRef } from '@farmslot/protocol';

import {
  type ArtifactType,
  workspaceArtifactBasename,
  workspaceArtifactType,
} from '../workspace/workspace-artifacts.js';

/** What the browser needs from an artifact; hosts pass their own artifact type. */
export type ArtifactBrowserItem = Pick<ArtifactRef, 'path' | 'purpose' | 'sizeBytes'>;

export interface ArtifactBrowserFile<T extends ArtifactBrowserItem> {
  kind: 'file';
  artifact: T;
  /** Position in the host's artifact list, so the host opens the right file. */
  index: number;
  name: string;
  type: ArtifactType;
}

/** Repeated runs of one check: same folder, name and extension, differing only by an attempt id. */
export interface ArtifactBrowserAttempts<T extends ArtifactBrowserItem> {
  kind: 'attempts';
  key: string;
  name: string;
  files: ArtifactBrowserFile<T>[];
}

export interface ArtifactBrowserFolder<T extends ArtifactBrowserItem> {
  kind: 'folder';
  path: string;
  name: string;
  fileCount: number;
  children: ArtifactBrowserNode<T>[];
}

export type ArtifactBrowserNode<T extends ArtifactBrowserItem> =
  | ArtifactBrowserFolder<T>
  | ArtifactBrowserAttempts<T>
  | ArtifactBrowserFile<T>;

export interface ArtifactBrowserFilter {
  query: string;
  /** Empty means every type. */
  types: ReadonlySet<ArtifactType>;
}

const ATTEMPT_NAME = /^(.+)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(\.[^/]+)$/i;

export function artifactBrowserQueryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function artifactBrowserMatches(
  artifact: ArtifactBrowserItem,
  filter: ArtifactBrowserFilter,
): boolean {
  if (filter.types.size && !filter.types.has(workspaceArtifactType(artifact))) return false;
  const path = artifact.path.toLowerCase();
  return artifactBrowserQueryTerms(filter.query).every((term) => path.includes(term));
}

/** The artifacts as a folder tree: filtered, attempts grouped, single-folder chains merged. */
export function artifactBrowserTree<T extends ArtifactBrowserItem>(
  artifacts: readonly T[],
  filter: ArtifactBrowserFilter,
): ArtifactBrowserFolder<T> {
  const root: ArtifactBrowserFolder<T> = {
    kind: 'folder',
    path: '',
    name: '',
    fileCount: 0,
    children: [],
  };
  artifacts.forEach((artifact, index) => {
    if (!artifactBrowserMatches(artifact, filter)) return;
    const segments = artifact.path.split('/').filter(Boolean);
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${segment}` : segment;
      let next = folder.children.find(
        (child): child is ArtifactBrowserFolder<T> =>
          child.kind === 'folder' && child.path === path,
      );
      if (!next) {
        next = { kind: 'folder', path, name: segment, fileCount: 0, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({
      kind: 'file',
      artifact,
      index,
      name: workspaceArtifactBasename(artifact.path),
      type: workspaceArtifactType(artifact),
    });
  });
  return finishFolder(root);
}

function finishFolder<T extends ArtifactBrowserItem>(
  folder: ArtifactBrowserFolder<T>,
): ArtifactBrowserFolder<T> {
  const folders = folder.children
    .filter((child): child is ArtifactBrowserFolder<T> => child.kind === 'folder')
    .map((child) => mergeSingleFolderChain(finishFolder(child)));
  const files = folder.children.filter(
    (child): child is ArtifactBrowserFile<T> => child.kind === 'file',
  );
  folder.children = [
    ...folders.sort((a, b) => a.name.localeCompare(b.name)),
    ...groupAttempts(folder.path, files).sort((a, b) => a.name.localeCompare(b.name)),
  ];
  folder.fileCount = files.length + folders.reduce((total, child) => total + child.fileCount, 0);
  return folder;
}

function mergeSingleFolderChain<T extends ArtifactBrowserItem>(
  folder: ArtifactBrowserFolder<T>,
): ArtifactBrowserFolder<T> {
  const [only] = folder.children;
  if (folder.children.length !== 1 || only?.kind !== 'folder') return folder;
  return { ...only, name: `${folder.name}/${only.name}` };
}

function groupAttempts<T extends ArtifactBrowserItem>(
  folderPath: string,
  files: ArtifactBrowserFile<T>[],
): Array<ArtifactBrowserFile<T> | ArtifactBrowserAttempts<T>> {
  const groups = new Map<string, ArtifactBrowserFile<T>[]>();
  for (const file of files) {
    const match = ATTEMPT_NAME.exec(file.name);
    if (!match) continue;
    const name = `${match[1]}-*${match[2]}`;
    groups.set(name, [...(groups.get(name) ?? []), file]);
  }
  const grouped = new Set<ArtifactBrowserFile<T>>();
  const nodes: Array<ArtifactBrowserFile<T> | ArtifactBrowserAttempts<T>> = [];
  for (const [name, members] of groups) {
    if (members.length < 2) continue;
    members.forEach((member) => grouped.add(member));
    nodes.push({ kind: 'attempts', key: `${folderPath}/${name}`, name, files: members });
  }
  return [...nodes, ...files.filter((file) => !grouped.has(file))];
}

export interface ArtifactBrowserRow<T extends ArtifactBrowserItem> {
  node: ArtifactBrowserNode<T>;
  depth: number;
  open: boolean;
}

/** The rows on screen, top to bottom: open folders and attempt groups show their children. */
export function artifactBrowserRows<T extends ArtifactBrowserItem>(
  root: ArtifactBrowserFolder<T>,
  isOpen: (key: string, soleChild: boolean) => boolean,
): ArtifactBrowserRow<T>[] {
  const rows: ArtifactBrowserRow<T>[] = [];
  const visit = (nodes: readonly ArtifactBrowserNode<T>[], depth: number) => {
    for (const node of nodes) {
      if (node.kind === 'file') {
        rows.push({ node, depth, open: false });
        continue;
      }
      const open = isOpen(artifactBrowserNodeKey(node), nodes.length === 1);
      rows.push({ node, depth, open });
      if (open) visit(node.kind === 'folder' ? node.children : node.files, depth + 1);
    }
  };
  visit(root.children, 0);
  return rows;
}

export function artifactBrowserNodeKey(node: ArtifactBrowserNode<ArtifactBrowserItem>): string {
  if (node.kind === 'folder') return `dir:${node.path}`;
  if (node.kind === 'attempts') return `attempts:${node.key}`;
  return `file:${node.artifact.path}`;
}

export type ArtifactBrowserKeyFileKind = 'report' | 'review' | 'learnings' | 'diff';

export interface ArtifactBrowserKeyFile {
  kind: ArtifactBrowserKeyFileKind;
  label: string;
  index: number;
}

const KEY_FILES: ReadonlyArray<{
  kind: ArtifactBrowserKeyFileKind;
  label: string;
  matches: (artifact: ArtifactBrowserItem, name: string) => boolean;
  /** Several candidates: the top-level one, or the latest round. */
  prefer: 'shallowest' | 'latest';
}> = [
  {
    kind: 'report',
    label: 'Report',
    matches: (artifact, name) => name === 'report.md' || artifact.purpose === 'report',
    prefer: 'shallowest',
  },
  {
    kind: 'review',
    label: 'Review',
    matches: (artifact, name) => name === 'review.md' || artifact.purpose === 'review',
    prefer: 'latest',
  },
  {
    kind: 'learnings',
    label: 'Learnings',
    matches: (artifact, name) => name === 'learnings.md' || artifact.purpose === 'learnings',
    prefer: 'shallowest',
  },
  {
    kind: 'diff',
    label: 'Diff',
    matches: (artifact) => workspaceArtifactType(artifact) === 'diff',
    prefer: 'shallowest',
  },
];

/** The files a decision usually starts from, in reading order. */
export function artifactBrowserKeyFiles(
  artifacts: readonly ArtifactBrowserItem[],
): ArtifactBrowserKeyFile[] {
  return KEY_FILES.flatMap(({ kind, label, matches, prefer }) => {
    const candidates = artifacts
      .map((artifact, index) => ({ artifact, index }))
      .filter(({ artifact }) =>
        matches(artifact, workspaceArtifactBasename(artifact.path).toLowerCase()),
      );
    if (!candidates.length) return [];
    const depth = (path: string) => path.split('/').length;
    const [best] = candidates.sort((a, b) =>
      prefer === 'shallowest'
        ? depth(a.artifact.path) - depth(b.artifact.path) ||
          a.artifact.path.localeCompare(b.artifact.path)
        : b.artifact.path.localeCompare(a.artifact.path, undefined, { numeric: true }),
    );
    return best ? [{ kind, label, index: best.index }] : [];
  });
}

/** What a key press on the focused tree row does; `row` is an index into the visible rows. */
export type ArtifactBrowserKeyAction =
  | { kind: 'focus'; row: number }
  | { kind: 'toggle'; row: number }
  | { kind: 'open'; row: number };

export function artifactBrowserKeyAction(
  rows: readonly ArtifactBrowserRow<ArtifactBrowserItem>[],
  focused: number,
  key: string,
): ArtifactBrowserKeyAction | null {
  const row = rows[focused];
  if (!row) return null;
  const focus = (target: number) =>
    target >= 0 && target < rows.length && target !== focused
      ? ({ kind: 'focus', row: target } as const)
      : null;
  const fileAfter = (step: 1 | -1) => {
    for (let index = focused + step; index >= 0 && index < rows.length; index += step)
      if (rows[index]?.node.kind === 'file') return focus(index);
    return null;
  };
  switch (key) {
    case 'ArrowDown':
      return focus(focused + 1);
    case 'ArrowUp':
      return focus(focused - 1);
    case 'Home':
      return focus(0);
    case 'End':
      return focus(rows.length - 1);
    case ']':
      return fileAfter(1);
    case '[':
      return fileAfter(-1);
    case 'ArrowRight':
      if (row.node.kind === 'file') return null;
      return row.open ? focus(focused + 1) : { kind: 'toggle', row: focused };
    case 'ArrowLeft': {
      if (row.node.kind !== 'file' && row.open) return { kind: 'toggle', row: focused };
      for (let index = focused - 1; index >= 0; index--)
        if ((rows[index]?.depth ?? 0) < row.depth) return focus(index);
      return null;
    }
    case 'Enter':
    case ' ':
      return row.node.kind === 'file'
        ? { kind: 'open', row: focused }
        : { kind: 'toggle', row: focused };
    default:
      return null;
  }
}
