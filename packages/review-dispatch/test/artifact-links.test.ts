import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildArtifactUrlResolver,
  decodeArtifactLink,
  isExternalWebLink,
  isHtmlArtifactPath,
} from '../src/artifact-links.js';

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

test('only an absolute http(s) link without credentials may leave a report', () => {
  for (const href of [
    'https://github.com/MetaMask/metamask-extension/pull/47016',
    'http://localhost:7801/docs',
    'HTTPS://example.com',
    'https://example.com/a@b',
  ])
    assert.equal(isExternalWebLink(href), true, href);
  for (const href of [
    'cases/qa-47016-reverse-run-2/trace.json',
    '#report-findings',
    '//example.com/x',
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'https:///example.com',
    'javascript:alert(1)',
    'farmslot-development:///run/other',
    'file:///etc/hosts',
  ])
    assert.equal(isExternalWebLink(href), false, href);
});

test('a link is decoded as written, and an undecodable one names nothing', () => {
  assert.equal(decodeArtifactLink('cases/run%202/trace.json'), 'cases/run 2/trace.json');
  assert.equal(decodeArtifactLink('cases/%E0%A4%A/trace.json'), null);
});
