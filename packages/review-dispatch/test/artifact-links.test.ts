import assert from 'node:assert/strict';
import test from 'node:test';

import { buildArtifactUrlResolver, isHtmlArtifactPath } from '../src/artifact-links.js';

test('report links resolve against the document directory, never an ambiguous basename', () => {
  const resolveUrl = buildArtifactUrlResolver(
    ['artifacts/report.md', 'artifacts/first/trace.json', 'artifacts/second/trace.json'],
    (file) => `/files/${file}`,
    'artifacts/report.md',
  );
  assert.equal(resolveUrl('second/trace.json'), '/files/artifacts/second/trace.json');
  assert.equal(resolveUrl('trace.json'), null);
  assert.equal(resolveUrl('missing/trace.json'), null);
  assert.equal(resolveUrl('../TASK.md'), null);
});

test('repeated artifact records keep a basename unique until another path shares it', () => {
  const file = 'artifacts/current/before.png';
  const resolveUrl = buildArtifactUrlResolver([file, file], (path) => `/files/${path}`);
  assert.equal(resolveUrl('before.png'), `/files/${file}`);
  assert.equal(
    buildArtifactUrlResolver([file, 'artifacts/old/before.png'], (path) => path)('before.png'),
    null,
  );
});

test('only an HTML artifact renders as a page', () => {
  assert.equal(isHtmlArtifactPath('artifacts/report.html'), true);
  assert.equal(isHtmlArtifactPath('artifacts/REPORT.HTM'), true);
  assert.equal(isHtmlArtifactPath('artifacts/qa-report.md'), false);
});
