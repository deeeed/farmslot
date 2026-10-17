import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createEvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';

import { isHtmlReport, readRunOutputReport } from './output-report';

const body = '<h1>Release validation</h1><p>Coverage gaps: none recorded.</p>';
const sha256 = createHash('sha256').update(body).digest('hex');

function qaRunModel() {
  return createEvidenceReviewModel({
    context: 'run-detail',
    report: {
      reportPath: 'artifacts/report.html',
      manifestDigest: 'manifest-digest',
      artifactManifest: [
        {
          path: 'artifacts/report.html',
          purpose: 'report',
          sha256,
          bundleDigest: 'bundle-digest',
        },
      ],
    },
  });
}

test('a run report is read from its retained bundle with the profile headers', async (t) => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string> });
    return new Response(body);
  });
  const report = await readRunOutputReport(qaRunModel(), {
    gatewayUrl: 'ws://gateway.test:7801',
    runId: 'run-qa',
    authHeaders: { Authorization: 'Bearer person-token' },
  });
  assert.equal(report.body, body);
  assert.equal(report.path, 'artifacts/report.html');
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/api/run-artifact');
  assert.equal(url.searchParams.get('runId'), 'run-qa');
  assert.equal(url.searchParams.get('path'), 'artifacts/report.html');
  assert.match(requests[0].url, /bundle-digest/);
  assert.equal(requests[0].headers.Authorization, 'Bearer person-token');
  assert.doesNotMatch(requests[0].url, /person-token/);
});

test('report bytes that differ from the retained digest are never shown', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(`${body} edited`));
  await assert.rejects(
    readRunOutputReport(qaRunModel(), {
      gatewayUrl: 'ws://gateway.test:7801',
      runId: 'run-qa',
      authHeaders: {},
    }),
    /bytes do not match/,
  );
});

test('a gateway error is reported instead of an empty report', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('missing', { status: 404 }));
  await assert.rejects(
    readRunOutputReport(qaRunModel(), {
      gatewayUrl: 'ws://gateway.test:7801',
      runId: 'run-qa',
      authHeaders: {},
    }),
    /HTTP 404/,
  );
});

test('only an HTML report renders as a page', () => {
  assert.equal(isHtmlReport('artifacts/report.html'), true);
  assert.equal(isHtmlReport('artifacts/REPORT.HTM'), true);
  assert.equal(isHtmlReport('artifacts/qa-report.md'), false);
});
