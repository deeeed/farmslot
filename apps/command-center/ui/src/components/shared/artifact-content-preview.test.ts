import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { litText } from '../../testing/lit-text.js';

mock.module('../../artifact-response.js', {
  namedExports: { readVerifiedArtifactPreview: async () => new Uint8Array() },
});
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceWorkspaceKey: () => undefined,
    subscribeResourceCache: () => () => undefined,
  },
});
const { ArtifactContentPreview } = await import('./artifact-content-preview.js');

test('large-log rendering mounts only the matching context with original line numbers', () => {
  const element = new ArtifactContentPreview();
  Object.assign(element, {
    text: Array.from({ length: 10000 }, (_, i) => `line ${i + 1}`).join('\n'),
    line: 8000,
    path: 'artifacts/large.log',
  });
  const rendered = litText(element.render());
  assert.equal(rendered.split('class="line ').length - 1, 201);
  assert.match(rendered, /8000<\/span>line 8000/);
  assert.doesNotMatch(rendered, />line 1<\/span>/);
});
