import assert from 'node:assert/strict';
import test from 'node:test';

import { buildArtifactUrlResolver } from '@farmslot/review-dispatch';

import { rewriteMarkdownArtifactUrls } from './artifact-markdown.js';

test('rewriteMarkdownArtifactUrls rewrites html and markdown local artifact URLs', () => {
  const resolveUrl = buildArtifactUrlResolver(
    ['artifacts/before-ac1.png', 'artifacts/after-ac1.png', 'artifacts/report.md'],
    (artifactPath) => `/api/run-artifact?path=${encodeURIComponent(artifactPath)}`,
  );

  const markdown = [
    '<img src="artifacts/before-ac1.png" />',
    '<a href="./artifacts/report.md">report</a>',
    '![after](after-ac1.png)',
    '[external](https://example.com/after-ac1.png)',
  ].join('\n');

  const rewritten = rewriteMarkdownArtifactUrls(markdown, resolveUrl);

  assert.match(rewritten, /src="\/api\/run-artifact\?path=artifacts%2Fbefore-ac1\.png"/);
  assert.match(rewritten, /href="\/api\/run-artifact\?path=artifacts%2Freport\.md"/);
  assert.match(rewritten, /!\[after\]\(\/api\/run-artifact\?path=artifacts%2Fafter-ac1\.png\)/);
  assert.match(rewritten, /\[external\]\(https:\/\/example\.com\/after-ac1\.png\)/);
});

test('rewriteMarkdownArtifactUrls refuses traversal and unknown relative URLs', () => {
  const resolveUrl = buildArtifactUrlResolver(
    ['artifacts/before-ac1.png'],
    (artifactPath) => `/api/run-artifact?path=${encodeURIComponent(artifactPath)}`,
  );

  const markdown = [
    '<img src="../secret.png" />',
    '<img src="missing.png" />',
    '<img src="data:image/png;base64,abc" />',
  ].join('\n');

  assert.equal(rewriteMarkdownArtifactUrls(markdown, resolveUrl), markdown);
});

test('frozen previews route explicit screenshot paths absent from the package inventory', () => {
  const resolveUrl = buildArtifactUrlResolver(
    [],
    (file) => `/api/run-artifact?path=${encodeURIComponent(file)}`,
  );
  const before = 'artifacts/current/screenshots/before-size-change.png';
  const rewritten = rewriteMarkdownArtifactUrls(
    `<img src="${before}" /><img src="${before}" />`,
    resolveUrl,
  );
  assert.equal(
    rewritten,
    `<img src="/api/run-artifact?path=${encodeURIComponent(before)}" /><img src="/api/run-artifact?path=${encodeURIComponent(before)}" />`,
  );
  assert.equal(resolveUrl('artifacts/../secret.png'), null);
  assert.equal(resolveUrl('missing/trace.json'), null);
  assert.equal(resolveUrl('https://example.com/frame.png'), null);
});
