import assert from 'node:assert/strict';
import test from 'node:test';

import { ARTIFACT_HTML_CSP } from '@farmslot/review-dispatch';

import {
  isolatedReportHtml,
  REPORT_DOCUMENT_BASE,
  reportArtifactResolver,
  reportNavigation,
} from './document-html';

// Paths and links taken from QA run 9c211c1e's retained report.
const resolve = reportArtifactResolver(
  [
    'artifacts/report.html',
    'artifacts/cases/qa-47016-reverse-run-2/trace.json',
    'artifacts/cases/qa-47016-reverse-run-2/videos/recipe-run.mp4',
  ],
  'artifacts/report.html',
);

test('the report carries the shared artifact CSP and loses refresh redirects', () => {
  const html = isolatedReportHtml(
    '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://example.com"><style>p{}</style></head><body><p>x</p></body></html>',
  );
  assert.match(
    html,
    new RegExp(
      `<head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_HTML_CSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`,
    ),
  );
  assert.doesNotMatch(html, /refresh/i);
  assert.match(isolatedReportHtml('<p>no head</p>'), /^<meta http-equiv="Content-Security-Policy"/);
});

test('in-page anchors and the initial load stay in the report', () => {
  assert.deepEqual(reportNavigation(REPORT_DOCUMENT_BASE, resolve, false), { kind: 'document' });
  assert.deepEqual(reportNavigation(`${REPORT_DOCUMENT_BASE}#report-findings`, resolve, true), {
    kind: 'document',
  });
});

test('a tapped evidence link opens the retained artifact it names', () => {
  assert.deepEqual(
    reportNavigation(
      `${REPORT_DOCUMENT_BASE}cases/qa-47016-reverse-run-2/trace.json`,
      resolve,
      true,
    ),
    { kind: 'artifact', path: 'artifacts/cases/qa-47016-reverse-run-2/trace.json' },
  );
  assert.deepEqual(
    reportNavigation(
      `${REPORT_DOCUMENT_BASE}cases/qa-47016-reverse-run-2/videos/recipe-run.mp4`,
      resolve,
      true,
    ),
    { kind: 'artifact', path: 'artifacts/cases/qa-47016-reverse-run-2/videos/recipe-run.mp4' },
  );
  assert.deepEqual(reportNavigation(`${REPORT_DOCUMENT_BASE}cases/missing.json`, resolve, true), {
    kind: 'blocked',
  });
});

test('web links open outside only on a tap; everything else is refused', () => {
  const pr = 'https://github.com/MetaMask/metamask-extension/pull/47016';
  assert.deepEqual(reportNavigation(pr, resolve, true), { kind: 'external', url: pr });
  assert.deepEqual(reportNavigation(pr, resolve, false), { kind: 'blocked' });
  for (const url of [
    'https://farmslot-report.invalid/secret',
    'https://user:pass@example.com/',
    'farmslot-development:///run/other',
    'javascript:alert(1)',
    'file:///etc/hosts',
  ])
    assert.deepEqual(reportNavigation(url, resolve, true), { kind: 'blocked' }, url);
});
