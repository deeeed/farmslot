import assert from 'node:assert/strict';

import {
  gatewayFetch,
  gatewayHttpAuthHeaders,
  gatewayResourceSource,
  gatewayResourceUrl,
} from './gateway-http-auth';

const headers = gatewayHttpAuthHeaders({ token: 'dev token' });
assert.deepEqual(headers, { Authorization: 'Bearer dev token' });

assert.equal(
  gatewayResourceUrl('https://example.test/api/run-artifact?runId=1&path=a.png', headers),
  'https://example.test/api/run-artifact?runId=1&path=a.png&token=dev%20token',
);

assert.equal(
  gatewayResourceUrl('https://example.test/api/run-artifact?runId=1&token=existing', headers),
  'https://example.test/api/run-artifact?runId=1&token=existing',
);

assert.deepEqual(gatewayResourceSource('https://example.test/artifact.png', headers), {
  uri: 'https://example.test/artifact.png?token=dev%20token',
  headers,
});

// gatewayFetch must keep the token in the header and never append it to the URL —
// fetch carries headers fine, so only the header-incapable Image/Source path
// (gatewayResourceSource) gets a query token.
let capturedUrl = '';
let capturedAuth = '';
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  capturedUrl = String(input);
  capturedAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
  return Promise.resolve(new Response(''));
}) as typeof fetch;
void gatewayFetch('https://example.test/api/run-artifact?runId=1&path=a.diff', headers);
globalThis.fetch = originalFetch;
assert.equal(capturedUrl, 'https://example.test/api/run-artifact?runId=1&path=a.diff');
assert.equal(capturedAuth, 'Bearer dev token');

console.log('gateway HTTP auth tests passed');
