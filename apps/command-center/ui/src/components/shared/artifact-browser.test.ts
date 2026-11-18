import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

import { GATEWAY_TOKEN_STORAGE_KEY, GATEWAY_URL_STORAGE_KEY } from '../../gateway-url.js';
import { litBinding, litBindings, litText } from '../../testing/lit-text.js';
import { gatewayHttpFetch } from '../../utils/gateway-origin.js';
import type { ArtifactType } from '../workspace/workspace-artifacts.js';

mock.module('./media-lightbox.js', { namedExports: {} });
mock.module('./artifact-content-search.js', { namedExports: {} });
mock.module('./artifact-content-preview.js', { namedExports: {} });

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

test('small inventories expose content search without adding the path-filter toolbar', () => {
  const { element } = fixture(1000);
  const text = litText(element.render());
  assert.match(text, /Search contents/);
  assert.doesNotMatch(text, /placeholder="Filter files"/);
});

test('relative search previews stay on the gateway origin rather than the dashboard origin', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'http://dashboard.local:5175/#runs' },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else Reflect.deleteProperty(globalThis, 'location');
  });
  const { element } = fixture(1000);
  element.artifactHref = () => '/api/run-artifact?runId=r&path=artifacts%2Freport.md';
  element.viewState = {
    query: '',
    types: new Set(),
    path: 'artifacts/report.md',
    preview: true,
    contentQuery: 'needle',
    line: 2,
    bundleDigest: 'bundle',
    contentSha256: 'a'.repeat(64),
  };
  const value = litBinding(element.render(), '.url=');
  assert.equal(typeof value, 'string');
  assert.equal(new URL(String(value)).origin, 'http://localhost:7777');
});

test('person-session preview transport keeps Authorization across separate UI and gateway origins', async (t) => {
  const props = new Map(
    ['location', 'window', 'localStorage', 'fetch'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  t.after(() => {
    for (const [key, desc] of props) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const token = `fsa_${'a'.repeat(32)}_${'b'.repeat(43)}`;
  const location = {
    href: 'http://dashboard.local:5175/#runs',
    origin: 'http://dashboard.local:5175',
    pathname: '/',
  };
  const store = new Map([
    [GATEWAY_URL_STORAGE_KEY, 'ws://gateway.local:7801/ws'],
    [GATEWAY_TOKEN_STORAGE_KEY, token],
  ]);
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location } });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
  });
  const requests: Array<{ url: string; auth: string | null }> = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') });
      return new Response('preview');
    },
  });
  const { element } = fixture(1000);
  element.artifactHref = () => '/api/run-artifact?runId=r&path=artifacts%2Freport.md';
  element.viewState = {
    query: '',
    types: new Set(),
    path: 'artifacts/report.md',
    preview: true,
    contentQuery: 'needle',
    line: 2,
    bundleDigest: 'bundle',
    contentSha256: 'a'.repeat(64),
  };
  const url = litBinding(element.render(), '.url=');
  assert.equal(typeof url, 'string');
  await gatewayHttpFetch(String(url), undefined, location);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].auth, `Bearer ${token}`);
  assert.equal(new URL(requests[0].url, location.origin).searchParams.has('token'), false);
});
