import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactContentPreviewWindow,
  artifactContentSearchParams,
} from './artifact-content-search-model.js';

test('content search binds every requested path to one retained run snapshot', () => {
  const result = artifactContentSearchParams('needle', [
    '/api/run-artifact?runId=r&path=artifacts%2Fa.log&bundleDigest=d',
    '/api/run-artifact?runId=r&path=artifacts%2Fb.json&bundleDigest=d',
  ]);
  assert.deepEqual(result, {
    runId: 'r',
    bundleDigest: 'd',
    query: 'needle',
    paths: ['artifacts/a.log', 'artifacts/b.json'],
  });
  assert.equal(
    artifactContentSearchParams('needle', [
      '/api/run-artifact?runId=r&path=a.log',
      '/api/run-artifact?runId=other&path=b.log',
    ]),
    undefined,
  );
});

test('content search refuses arbitrary links and keeps selected recipe scope', () => {
  assert.equal(artifactContentSearchParams('needle', ['https://example.org/file.log']), undefined);
  assert.deepEqual(
    artifactContentSearchParams('needle', [
      '/api/run-artifact?runId=r&path=a.log&recipeRunId=recipe',
    ]),
    {
      runId: 'r',
      recipeRunId: 'recipe',
      query: 'needle',
      paths: ['a.log'],
    },
  );
});

test('foreign gateway links and malformed URLs never become a search on the current gateway', () => {
  assert.equal(
    artifactContentSearchParams('x', ['http://other/api/run-artifact?runId=r&path=a.log']),
    undefined,
  );
  assert.equal(artifactContentSearchParams('x', ['http://']), undefined);
  assert.deepEqual(
    artifactContentSearchParams(
      'x',
      ['http://own/api/run-artifact?runId=r&path=a.log&decisionId=gate'],
      'http://own',
    ),
    {
      runId: 'r',
      query: 'x',
      paths: ['a.log'],
      decisionId: 'gate',
    },
  );
});

test('line preview keeps original numbers while bounding large logs to 201 rows', () => {
  const preview = artifactContentPreviewWindow(
    Array.from({ length: 10000 }, (_, i) => `line ${i + 1}`).join('\n'),
    8000,
  );
  assert.equal(preview.lines.length, 201);
  assert.equal(preview.totalLines, 10000);
  assert.equal(preview.lines[8000 - preview.firstLine], 'line 8000');
});

test('text eligibility precedes the path cap and retains only selected path versions', () => {
  const links = [
    ...Array.from({ length: 500 }, (_, i) => `/api/run-artifact?runId=r&path=a${i}.png&v=image`),
    '/api/run-artifact?runId=r&path=z.log&v=log',
  ];
  const params = artifactContentSearchParams('needle', links);
  assert.deepEqual(params?.paths, ['z.log']);
  assert.deepEqual(params?.versions, { 'z.log': 'log' });
});
