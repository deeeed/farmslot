// Every screen that shows a diff or a changed-file list gets the "hide tests"
// toggle through DiffTestFilterController. This scans the whole UI source: a
// file that renders templates and shows diff content must render the
// controller's controls (`testFilter.renderControls` for a list,
// `testFilter.renderFileDiff` for a one-file diff) or hand its controller to a
// renderer that does. Nothing is exempt except the dev harness pages, which are
// listed so a new one is a deliberate choice.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A diff viewer: the shared element, a source view with changed lines, a diff split, or hand-coloured diff lines. */
const DIFF_VIEWER_MARKERS = [
  /<diff-review\b/,
  /<code-viewer\b[^>]*?\.changedLines=/,
  /\b(parseUnifiedDiff|splitUnifiedDiff)\(/,
  /startsWith\(\s*['"](@@|\+\+\+)/,
];

/** Changed-file list data. */
const FILE_LIST_MARKERS = [
  /\b(GitBranchDiffFile|BranchDiffFile|NativeWorkspaceChangesResult|ImprovementFileChange|DiffFileEntry)\b/,
];

/** Diff views that must be found, so a scanner regression cannot pass silently. */
const KNOWN_DIFF_VIEWS = [
  'components/chat/native-workspace.ts',
  'components/decisions/decision-inbox.ts',
  'components/shared/diff-viewer-modal.ts',
  'components/shared/media-lightbox.ts',
  'components/slot-view/slot-view-source-renderers.ts',
  'components/workspace/branch-changed-files.ts',
  'components/workspace/git-changes.ts',
  'components/workspace/ready-workspace-shell-renderers.ts',
  'components/workspace/review-workspace-shell-renderers.ts',
  'components/workspace/review-workspace.ts',
  'components/workspace/slot-workspace.ts',
];

/** Dev harness pages (`dev/`, not shipped screens) that show mock diffs. */
const DEV_HARNESS_DIFF_VIEWS: Record<string, string> = {
  'dev/dev-harness.ts': 'component gallery: mock diff-review, code-viewer and list fixtures',
  'dev/improvement-dev.ts': 'mock improvement proposal (diff2html), opened from the gallery',
};

function uiSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    if (relative.startsWith('testing/') || relative.startsWith('generated/')) continue;
    sources.set(relative, readFileSync(file, 'utf8'));
  }
  return sources;
}

function isDiffView(source: string): boolean {
  return (
    source.includes('html`') &&
    [...DIFF_VIEWER_MARKERS, ...FILE_LIST_MARKERS].some((marker) => marker.test(source))
  );
}

function usesFilter(source: string): boolean {
  return /[tT]estFilter(\.(renderControls|renderFileDiff)\(|: this\._testFilter\b)/.test(source);
}

const sources = uiSources();
const diffViews = [...sources].filter(([, source]) => isDiffView(source)).map(([file]) => file);

test('every diff or changed-file view renders the shared hide-tests filter', () => {
  const missing = diffViews.filter(
    (file) => !(file in DEV_HARNESS_DIFF_VIEWS) && !usesFilter(sources.get(file) ?? ''),
  );
  assert.deepEqual(
    missing,
    [],
    'render the list with testFilter.renderControls, a one-file diff with ' +
      'testFilter.renderFileDiff, or pass the controller to a renderer that does',
  );
});

test('the scan finds every known diff view', () => {
  for (const file of KNOWN_DIFF_VIEWS) {
    assert.ok(diffViews.includes(file), `${file} is no longer detected as a diff view`);
  }
});

test('the dev harness exclusions match the dev pages that show diffs', () => {
  assert.deepEqual(
    diffViews.filter((file) => file.startsWith('dev/')).sort(),
    Object.keys(DEV_HARNESS_DIFF_VIEWS).sort(),
  );
});

test('the markers catch a hand-rolled diff view', () => {
  const handRolled = [
    'return html`${lines.map((line) => line.startsWith("@@") ? hunk(line) : row(line))}`;',
    'return html`<code-viewer .content=${src} .changedLines=${lines}></code-viewer>`;',
  ];
  for (const source of handRolled) {
    assert.equal(isDiffView(source), true, source);
    assert.equal(usesFilter(source), false);
  }
});
