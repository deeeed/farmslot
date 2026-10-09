import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// diff-review pulls CSS node can't load.
mock.module('../diff-viewer/diff-review.js', { namedExports: {} });

const { MediaLightbox } = await import('./media-lightbox.js');

/** The private state the test drives. */
interface Lightbox {
  open: boolean;
  items: Array<{ url: string; path: string; purpose: string }>;
  selectedIndex: number;
  _kindFilter: string;
  willUpdate(changed: Map<string, unknown>): void;
}

const items = [
  { url: '/a', path: 'artifacts/before-sheet.png', purpose: 'screenshot' },
  { url: '/b', path: 'artifacts/after-sheet.png', purpose: 'screenshot' },
  { url: '/c', path: 'artifacts/after-list.png', purpose: 'screenshot' },
  { url: '/d', path: 'artifacts/teardown-final-state.png', purpose: 'screenshot' },
];

test('opening the lightbox clears a kind filter left from the last visit', () => {
  const view = Object.create(MediaLightbox.prototype) as Lightbox;
  Object.assign(view, { requestUpdate: () => undefined });
  Object.assign(view, { open: false, items, selectedIndex: 0, _kindFilter: 'after' });

  view.willUpdate(new Map([['_kindFilter', 'all']]));
  assert.equal(view._kindFilter, 'after', 'choosing a filter while browsing keeps it');

  view.open = true;
  view.willUpdate(new Map([['open', false]]));
  assert.equal(view._kindFilter, 'all');
});

test('a host selecting a file the filter hides clears it; browsing within the filter keeps it', () => {
  const view = Object.create(MediaLightbox.prototype) as Lightbox;
  Object.assign(view, { requestUpdate: () => undefined });
  Object.assign(view, { open: true, items, selectedIndex: 1, _kindFilter: 'after' });

  view.selectedIndex = 2;
  view.willUpdate(new Map([['selectedIndex', 1]]));
  assert.equal(view._kindFilter, 'after', 'next within the After files keeps the filter');

  view.selectedIndex = 3;
  view.willUpdate(new Map([['selectedIndex', 2]]));
  assert.equal(view._kindFilter, 'all', 'a link to teardown shows teardown');
});
