import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, mock, test } from 'node:test';

import { nativeToolDiffText } from '@farmslot/protocol/client-cache';

import { litText } from '../../testing/lit-text.js';

const css = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});
after(() => css.deregister());
mock.module('lit/directives/unsafe-html.js', {
  namedExports: { unsafeHTML: (value: string) => value },
});
const { DiffReview } = await import('./diff-review.js');

test('a native file creation renders as added without inventing Git file modes', () => {
  const view = new DiffReview();
  view.diff = nativeToolDiffText({ path: 'new.txt', oldText: null, newText: 'hello ACP\n' });
  view.newFile = true;
  const text = litText(view.render());
  assert.match(text, /ADDED/);
  assert.doesNotMatch(text, /RENAMED/);
  assert.match(text, /hello ACP/);
});
