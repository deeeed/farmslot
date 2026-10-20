import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type ArtifactBrowserFilter,
  type ArtifactBrowserFolder,
  type ArtifactBrowserItem,
  artifactBrowserKeyAction,
  artifactBrowserKeyFiles,
  artifactBrowserRows,
  artifactBrowserTree,
} from './artifact-browser-model.js';

const NO_FILTER: ArtifactBrowserFilter = { query: '', types: new Set() };

const artifacts: ArtifactBrowserItem[] = [
  { path: 'artifacts/report.md', purpose: 'report' },
  {
    path: 'artifacts/checks/CHECKLIST.md/18-18c36200-2bbc-4935-b8f1-7df6c505daf9.log',
    purpose: 'other',
  },
  {
    path: 'artifacts/checks/CHECKLIST.md/18-23199ca3-1a44-4006-99e1-9993853b1569.log',
    purpose: 'other',
  },
  { path: 'artifacts/checks/CHECKLIST.md/18.json', purpose: 'other' },
  { path: 'artifacts/videos/run.mp4', purpose: 'video' },
];

function outline(folder: ArtifactBrowserFolder<ArtifactBrowserItem>): string[] {
  return artifactBrowserRows(folder, () => true).map(
    ({ node, depth }) =>
      `${'  '.repeat(depth)}${node.kind === 'folder' ? `${node.name}/ ${node.fileCount}` : node.kind === 'attempts' ? `${node.name} x${node.files.length}` : node.name}`,
  );
}

test('artifactBrowserTree nests folders, merges single-folder chains and groups attempts', () => {
  assert.deepEqual(outline(artifactBrowserTree(artifacts, NO_FILTER)), [
    'artifacts/ 5',
    '  checks/CHECKLIST.md/ 3',
    '    18-*.log x2',
    '      18-18c36200-2bbc-4935-b8f1-7df6c505daf9.log',
    '      18-23199ca3-1a44-4006-99e1-9993853b1569.log',
    '    18.json',
    '  videos/ 1',
    '    run.mp4',
    '  report.md',
  ]);
});

test('artifactBrowserTree keeps host indexes so the host opens the clicked file', () => {
  const rows = artifactBrowserRows(artifactBrowserTree(artifacts, NO_FILTER), () => true);
  const video = rows.find((row) => row.node.kind === 'file' && row.node.name === 'run.mp4');
  assert.equal(video?.node.kind === 'file' && video.node.index, 4);
});

test('artifactBrowserTree filters by every query term and by type', () => {
  const byQuery = artifactBrowserTree(artifacts, { query: 'CHECKLIST json', types: new Set() });
  assert.equal(byQuery.fileCount, 1);
  const byType = artifactBrowserTree(artifacts, { query: '', types: new Set(['log', 'video']) });
  assert.equal(byType.fileCount, 3);
});

test('artifactBrowserRows opens a sole child by default and hides closed children', () => {
  const tree = artifactBrowserTree(artifacts, NO_FILTER);
  const rows = artifactBrowserRows(tree, (_key, soleChild) => soleChild);
  assert.deepEqual(
    rows.map((row) =>
      row.node.kind === 'file' ? row.node.name : `${row.node.name}${row.open ? ' open' : ''}`,
    ),
    ['artifacts open', 'checks/CHECKLIST.md', 'videos', 'report.md'],
  );
});

test('artifactBrowserKeyFiles picks the top-level report and the latest review round', () => {
  const files: ArtifactBrowserItem[] = [
    { path: 'artifacts/pipeline-review-loop-2/review.md', purpose: 'review' },
    { path: 'artifacts/pipeline-review-loop-10/review.md', purpose: 'review' },
    { path: 'artifacts/recipe-run/report.md', purpose: 'report' },
    { path: 'artifacts/report.md', purpose: 'report' },
    { path: 'artifacts/diff.txt', purpose: 'other' },
    { path: 'artifacts/notes.md', purpose: 'other' },
  ];
  assert.deepEqual(
    artifactBrowserKeyFiles(files).map(({ label, index }) => `${label}:${files[index]?.path}`),
    [
      'Report:artifacts/report.md',
      'Review:artifacts/pipeline-review-loop-10/review.md',
      'Diff:artifacts/diff.txt',
    ],
  );
});

test('artifactBrowserKeyAction walks the tree like a file explorer', () => {
  const tree = artifactBrowserTree(artifacts, NO_FILTER);
  const open = artifactBrowserRows(tree, () => true);
  const names = open.map(({ node }) => (node.kind === 'file' ? node.name : node.name));
  const at = (name: string) => names.indexOf(name);
  assert.deepEqual(artifactBrowserKeyAction(open, 0, 'ArrowDown'), { kind: 'focus', row: 1 });
  assert.equal(artifactBrowserKeyAction(open, 0, 'ArrowUp'), null);
  assert.deepEqual(artifactBrowserKeyAction(open, at('18.json'), 'ArrowLeft'), {
    kind: 'focus',
    row: at('checks/CHECKLIST.md'),
  });
  assert.deepEqual(artifactBrowserKeyAction(open, at('videos'), 'ArrowLeft'), {
    kind: 'toggle',
    row: at('videos'),
  });
  assert.deepEqual(artifactBrowserKeyAction(open, at('18.json'), ']'), {
    kind: 'focus',
    row: at('run.mp4'),
  });
  assert.deepEqual(artifactBrowserKeyAction(open, at('run.mp4'), 'Enter'), {
    kind: 'open',
    row: at('run.mp4'),
  });
  const closed = artifactBrowserRows(tree, (_key, soleChild) => soleChild);
  const videos = closed.findIndex(({ node }) => node.kind === 'folder' && node.name === 'videos');
  assert.deepEqual(artifactBrowserKeyAction(closed, videos, 'ArrowRight'), {
    kind: 'toggle',
    row: videos,
  });
});
