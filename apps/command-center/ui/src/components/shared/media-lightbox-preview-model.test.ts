import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  formatLightboxTextPreview,
  sameOriginLightboxFetchUrl,
} from './media-lightbox-preview-model.js';

test('same-origin lightbox fetch urls strip UI and gateway origins only', () => {
  const base = {
    locationHref: 'http://localhost:5175/#dev/lightbox',
    windowOrigin: 'http://localhost:5175',
    gatewayOrigin: 'http://localhost:7777',
  };

  assert.equal(
    sameOriginLightboxFetchUrl({ ...base, url: 'http://localhost:5175/artifacts/a.md?raw=1#top' }),
    '/artifacts/a.md?raw=1#top',
  );
  assert.equal(
    sameOriginLightboxFetchUrl({ ...base, url: 'http://localhost:7777/artifacts/a.md' }),
    '/artifacts/a.md',
  );
  assert.equal(
    sameOriginLightboxFetchUrl({ ...base, url: 'https://example.test/artifacts/a.md' }),
    'https://example.test/artifacts/a.md',
  );
  assert.equal(sameOriginLightboxFetchUrl({ ...base, url: '::::' }), '/::::');
});

test('text preview formatter preserves markdown, json, diff, and malformed json behavior', () => {
  assert.equal(
    formatLightboxTextPreview('markdown', '**Ready**', (markdown) => `<p>${markdown}</p>`),
    '<p>**Ready**</p>',
  );
  assert.equal(formatLightboxTextPreview('json', '{"b":2,"a":1}'), '{\n  "b": 2,\n  "a": 1\n}');
  assert.equal(formatLightboxTextPreview('json', '{not-json'), '{not-json');
  assert.equal(
    formatLightboxTextPreview('diff', 'diff --git a/file b/file'),
    'diff --git a/file b/file',
  );
});
