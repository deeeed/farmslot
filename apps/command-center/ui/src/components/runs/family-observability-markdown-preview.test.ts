import assert from 'node:assert/strict';
import test from 'node:test';

import {
  familyMarkdownPreviewDisplay,
  familyMarkdownPreviewFetchPath,
  familyMarkdownPreviewText,
} from './family-observability-markdown-preview.js';

test('familyMarkdownPreviewFetchPath strips gateway base for proxied artifact fetches', () => {
  assert.equal(
    familyMarkdownPreviewFetchPath(
      'http://localhost:7777',
      'http://localhost:7777/api/run-artifact?x=1',
    ),
    '/api/run-artifact?x=1',
  );
  assert.equal(
    familyMarkdownPreviewFetchPath('http://localhost:7777', '/api/run-artifact?x=1'),
    '/api/run-artifact?x=1',
  );
  assert.equal(
    familyMarkdownPreviewFetchPath(
      'http://localhost:7777',
      'http://localhost:7777/api/run-artifact?x=1&token=t',
      '/cc/',
    ),
    'http://localhost:7777/api/run-artifact?x=1&token=t',
  );
});

test('familyMarkdownPreviewText strips markdown chrome and truncates first content line', () => {
  const long = `${'a'.repeat(160)} tail`;
  assert.equal(
    familyMarkdownPreviewText(
      `---\ntitle: demo\n---\n\n# Heading\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n![alt](image.png)\n*${long}*`,
    ),
    'Heading',
  );
  assert.equal(familyMarkdownPreviewText(`\n\n_${long}_`).length, 140);
});

test('familyMarkdownPreviewDisplay maps fetch states to stable labels', () => {
  assert.equal(familyMarkdownPreviewDisplay(undefined), '…');
  assert.equal(familyMarkdownPreviewDisplay({ status: 'loading' }), '…');
  assert.equal(familyMarkdownPreviewDisplay({ status: 'err', error: 'boom' }), 'Preview failed');
  assert.equal(familyMarkdownPreviewDisplay({ status: 'ok', data: 'Ready' }), 'Ready');
});
