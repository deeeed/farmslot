import assert from 'node:assert/strict';
import test from 'node:test';

import { GATEWAY_TOKEN_STORAGE_KEY } from '../../gateway-url.js';
import { gatewayProxiedFetchUrl } from '../../utils/gateway-origin.js';

import {
  familyMarkdownPreviewDisplay,
  familyMarkdownPreviewFetchPath,
  familyMarkdownPreviewText,
} from './family-observability-markdown-preview.js';

function withMockLocalStorage(fn: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        store.set(key, value);
      },
      removeItem(key: string): void {
        store.delete(key);
      },
    },
  });
  try {
    fn();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, 'localStorage', previous);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
}

test('familyMarkdownPreviewFetchPath strips gateway base for proxied artifact fetches', () => {
  withMockLocalStorage(() => {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, 'dev-token');
    assert.equal(
      familyMarkdownPreviewFetchPath(
        'http://localhost:7777',
        'http://localhost:7777/api/run-artifact?x=1',
      ),
      '/api/run-artifact?x=1&token=dev-token',
    );
    assert.equal(
      familyMarkdownPreviewFetchPath('http://localhost:7777', '/api/run-artifact?x=1'),
      '/api/run-artifact?x=1&token=dev-token',
    );
  });
});

test('familyMarkdownPreviewFetchPath keeps hosted /cc artifact URLs absolute with token', () => {
  withMockLocalStorage(() => {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, 'hosted-token');
    assert.equal(
      familyMarkdownPreviewFetchPath(
        'http://localhost:7777',
        'http://localhost:7777/api/run-artifact?x=1&token=t',
        '/cc/',
      ),
      'http://localhost:7777/api/run-artifact?x=1&token=t',
    );
    assert.equal(
      gatewayProxiedFetchUrl('/api/run-artifact?x=1', {
        href: 'https://farmslot.io/cc/#family/demo',
        origin: 'https://farmslot.io',
        pathname: '/cc/',
      }),
      'http://localhost:7777/api/run-artifact?x=1&token=hosted-token',
    );
  });
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
