import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import { mountHook } from './hook-harness.fixtures';
import type { RunOutputReport } from './useRunOutputReport';

test('late report read cannot open under a different review context', async (t) => {
  let finish: (value: unknown) => void = () => assert.fail('read did not start');
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  let alerts = 0;
  let reads = 0;
  const hook = mountHook<[Record<string, unknown>]>(
    new URL('./useRunOutputReport.ts', import.meta.url),
    'useRunOutputReport',
    {
      'react-native': {
        Alert: {
          alert: () => {
            alerts++;
          },
        },
      },
      '@farmslot/review-dispatch': { isHtmlArtifactPath: () => false },
      '../lib/output-report': {
        readRunOutputReport: () => {
          reads++;
          return pending;
        },
      },
    },
    { AbortController },
  );
  t.after(hook.cleanup);
  const options = {
    runId: 'run-a',
    gatewayUrl: 'http://fixture.invalid',
    contextKey: 'review-a',
    evidenceModel: { report: { manifestDigest: 'manifest-a' } },
    authHeaders: {},
  };
  const first = hook.render(options) as RunOutputReport;
  const opening = first.open();
  const next = { ...options, contextKey: 'review-b' };
  hook.render(next);
  finish({ caption: 'Old report', body: 'Old bytes', path: 'artifacts/report.md' });
  await opening;
  assert.equal((hook.render(next) as RunOutputReport).document, null);
  assert.equal(alerts, 0);
  await first.open();
  assert.equal(reads, 1, 'A retained old open callback must not start another read');
  const current = hook.render(next) as RunOutputReport;
  await current.open();
  assert.equal(reads, 2);
  assert.equal((hook.render(next) as RunOutputReport).document?.title, 'Old report');
  const another = { ...next, contextKey: 'review-c' };
  assert.equal((hook.render(another) as RunOutputReport).document, null);
});
