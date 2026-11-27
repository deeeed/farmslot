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

test('unassigned media clears unsupported role filters; browsing within Unassigned keeps its filter', () => {
  const view = Object.create(MediaLightbox.prototype) as Lightbox;
  Object.assign(view, { requestUpdate: () => undefined });
  Object.assign(view, { open: true, items, selectedIndex: 1, _kindFilter: 'after' });

  view.selectedIndex = 2;
  view.willUpdate(new Map([['selectedIndex', 1]]));
  assert.equal(view._kindFilter, 'all', 'filenames do not assign an After role');
  view._kindFilter = 'setup';

  view.selectedIndex = 3;
  view.willUpdate(new Map([['selectedIndex', 2]]));
  assert.equal(view._kindFilter, 'setup', 'all unbound media remains in the same filter');
});

test('a rounded video endpoint seeks and pauses, while a later millisecond is unavailable', () => {
  const url = '/video';
  let pauses = 0;
  const video = {
    readyState: 1,
    duration: 1.666667,
    currentTime: 0,
    pause() {
      pauses++;
    },
  };
  const events: string[] = [];
  interface SeekState {
    _pendingSeek: { ms: number; itemUrl: string; pause: boolean };
    _applyPendingSeek(video: unknown): void;
  }
  const view = Object.assign(Object.create(MediaLightbox.prototype), {
    _videoSet: () => [video],
    _videoItemUrls: new Map([[video, url]]),
    dispatchEvent: (event: Event) => events.push(event.type),
  }) as SeekState;

  view._pendingSeek = { ms: 1667, itemUrl: url, pause: true };
  view._applyPendingSeek(video);
  assert.equal(video.currentTime, video.duration);
  assert.equal(pauses, 1);
  assert.deepEqual(events, []);

  view._pendingSeek = { ms: 1668, itemUrl: url, pause: true };
  view._applyPendingSeek(video);
  assert.equal(video.currentTime, video.duration);
  assert.equal(pauses, 1);
  assert.deepEqual(events, ['lightbox-seek-unavailable']);
});
