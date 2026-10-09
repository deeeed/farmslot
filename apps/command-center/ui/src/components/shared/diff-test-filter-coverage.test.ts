// Every screen that shows a diff or a changed-file list gets the "hide tests"
// toggle through DiffTestFilterController. This scans the components: a file
// that renders templates and shows diff content must use the controller and
// render its controls, or be listed in DELEGATED with the filtered view that
// owns its list.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const COMPONENTS = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** A diff viewer, a multi-file diff split, or changed-file list data. */
const DIFF_VIEW_MARKERS = [
  /<diff-review\b/,
  /\bparseUnifiedDiff\(/,
  /\b(GitBranchDiffFile|BranchDiffFile|NativeWorkspaceChangesResult|ImprovementFileChange|DiffFileEntry)\b/,
  /\bcommittedFiles\b/,
];

/** Diff views that must be found, so a scanner regression cannot pass silently. */
const KNOWN_DIFF_VIEWS = [
  'chat/native-workspace.ts',
  'decisions/decision-inbox.ts',
  'shared/diff-viewer-modal.ts',
  'shared/media-lightbox.ts',
  'workspace/branch-changed-files.ts',
  'workspace/git-changes.ts',
  'workspace/ready-workspace-shell-renderers.ts',
  'workspace/review-workspace.ts',
];

/** Files that show diff content but whose list is filtered by another view. */
const DELEGATED: Record<string, { reason: string; filteredBy: string[] }> = {
  'slot-view/slot-view-source-renderers.ts': {
    reason: 'editor tab for one file, opened from the slot changed-file lists',
    filteredBy: ['workspace/git-changes.ts', 'workspace/branch-changed-files.ts'],
  },
  'slot-view/slot-view-panel-renderers.ts': {
    reason: 'hands the branch diff to the slot changed-file lists',
    filteredBy: ['workspace/git-changes.ts', 'workspace/branch-changed-files.ts'],
  },
  'workspace/review-workspace-shell-renderers.ts': {
    reason: 'renders one file tab; review-workspace filters the tab list',
    filteredBy: ['workspace/review-workspace.ts'],
  },
};

function componentSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(COMPONENTS, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const file = path.join(entry.parentPath, entry.name);
    sources.set(
      path.relative(COMPONENTS, file).split(path.sep).join('/'),
      readFileSync(file, 'utf8'),
    );
  }
  return sources;
}

function isDiffView(source: string): boolean {
  return source.includes('html`') && DIFF_VIEW_MARKERS.some((marker) => marker.test(source));
}

function usesFilter(source: string): boolean {
  return source.includes('DiffTestFilterController') && source.includes('.renderControls(');
}

const sources = componentSources();
const diffViews = [...sources].filter(([, source]) => isDiffView(source)).map(([file]) => file);

test('every diff or changed-file view renders the shared hide-tests filter', () => {
  const missing = diffViews.filter(
    (file) => !(file in DELEGATED) && !usesFilter(sources.get(file) ?? ''),
  );
  assert.deepEqual(
    missing,
    [],
    'render the list through DiffTestFilterController (split + renderControls), or add the ' +
      'file to DELEGATED naming the filtered view that owns its list',
  );
});

test('the scan finds every known diff view', () => {
  for (const file of KNOWN_DIFF_VIEWS) {
    assert.ok(diffViews.includes(file), `${file} is no longer detected as a diff view`);
  }
});

test('delegated files still show diff content and point at filtered views', () => {
  for (const [file, { filteredBy }] of Object.entries(DELEGATED)) {
    assert.ok(diffViews.includes(file), `${file} no longer shows diff content; drop it`);
    for (const owner of filteredBy) {
      assert.ok(
        usesFilter(sources.get(owner) ?? ''),
        `${file} relies on ${owner}, which is unfiltered`,
      );
    }
  }
});
