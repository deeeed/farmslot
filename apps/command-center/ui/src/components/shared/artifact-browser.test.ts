import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

import { litBinding, litBindings, litText } from '../../testing/lit-text.js';
import type { ArtifactType } from '../workspace/workspace-artifacts.js';

mock.module('./media-lightbox.js', { namedExports: {} });

class ResizeMock implements ResizeObserver {
  static latest?: ResizeMock;
  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeMock.latest = this;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  deliver(target: Element, width: number): void {
    const contentRect: DOMRectReadOnly = {
      x: 0,
      y: 0,
      width,
      height: 300,
      top: 0,
      right: width,
      bottom: 300,
      left: 0,
      toJSON: () => ({ width, height: 300 }),
    };
    this.callback(
      [
        {
          target,
          contentRect,
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
}
const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: ResizeMock });
after(() => {
  if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous);
  else Reflect.deleteProperty(globalThis, 'ResizeObserver');
});

const { ArtifactBrowser } = await import('./artifact-browser.js');

function fixture(width: number) {
  const element = new ArtifactBrowser();
  element.artifacts = [
    { path: 'artifacts/report.md', purpose: 'report' },
    { path: 'artifacts/report.md', purpose: 'report' },
  ];
  element.artifactHref = (index) => `/run/${index}/report.md`;
  const observer = ResizeMock.latest;
  assert.ok(observer);
  observer.deliver(element, width);
  return { element, observer };
}

test('small filtered inventories keep their controls and selected zero-count type visible', () => {
  const { element } = fixture(1000);
  element.artifacts = [
    { path: 'notes/one.md', purpose: 'report' },
    { path: 'notes/two.md', purpose: 'report' },
  ];
  element.viewState = {
    query: '',
    types: new Set<ArtifactType>(['video']),
    path: null,
    preview: false,
  };
  const filtered = litText(element.render());
  assert.match(filtered, /placeholder="Filter files"/);
  assert.match(filtered, /Videos<span>0<\/span>/);
  assert.match(filtered, /No files match/);
  element.viewState = { ...element.viewState, types: new Set<ArtifactType>() };
  const cleared = litText(element.render());
  assert.doesNotMatch(cleared, /placeholder="Filter files"|Videos<span>/);
  assert.match(cleared, /one\.md/);
});

test('a saved search stays editable when a small run has no matching files', () => {
  const { element } = fixture(1000);
  element.viewState = {
    query: 'missing-file',
    types: new Set<ArtifactType>(),
    path: null,
    preview: false,
  };
  const text = litText(element.render());
  assert.match(text, /placeholder="Filter files"/);
  assert.match(text, /No files match/);
});

function clickLastFile(element: InstanceType<typeof ArtifactBrowser>) {
  const click = litBindings(element.render(), '@click=').at(-1);
  assert.ok(typeof click === 'function');
  click(new Event('click', { cancelable: true }));
}

test('uncontrolled previews retain the host index when runs share a filename', () => {
  const { element } = fixture(1000);
  clickLastFile(element);
  assert.equal(litBinding(element.render(), '.selectedIndex='), 1);
});

test('uncontrolled previews do not open merely because the browser narrows', () => {
  const { element, observer } = fixture(1000);
  clickLastFile(element);
  observer.deliver(element, 400);
  assert.doesNotMatch(litText(element.render()), /class="overlay"/);
  clickLastFile(element);
  assert.match(litText(element.render()), /class="overlay"/);
  observer.deliver(element, 1000);
  observer.deliver(element, 400);
  assert.doesNotMatch(litText(element.render()), /class="overlay"/);
});

test('a missing bookmarked file never previews another artifact', () => {
  const { element } = fixture(1000);
  element.viewState = {
    query: '',
    types: new Set(),
    path: 'artifacts/removed-report.md',
    preview: true,
  };
  assert.equal(litBinding(element.render(), '.items='), undefined);
  assert.match(litText(element.render()), /File unavailable.*artifacts\/removed-report.md/s);
});
