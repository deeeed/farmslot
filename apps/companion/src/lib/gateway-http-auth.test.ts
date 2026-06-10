import assert from 'node:assert/strict';

import {
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

console.log('gateway HTTP auth tests passed');
