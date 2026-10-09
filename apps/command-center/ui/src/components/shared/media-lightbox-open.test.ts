import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// diff-review pulls CSS node can't load.
mock.module('../diff-viewer/diff-review.js', { namedExports: {} });

const { MediaLightbox } = await import('./media-lightbox.js');

/** The private state the test drives. */
interface Lightbox {
  open: boolean;
  _kindFilter: string;
  willUpdate(changed: Map<string, unknown>): void;
}

test('opening the lightbox clears a kind filter left from the last visit', () => {
  const view = Object.create(MediaLightbox.prototype) as Lightbox;
  Object.assign(view, { requestUpdate: () => undefined });
  Object.assign(view, { open: false, _kindFilter: 'after' });

  view.willUpdate(new Map([['_kindFilter', 'all']]));
  assert.equal(view._kindFilter, 'after', 'choosing a filter while browsing keeps it');

  view.open = true;
  view.willUpdate(new Map([['open', false]]));
  assert.equal(view._kindFilter, 'all');
});
