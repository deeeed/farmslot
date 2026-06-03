import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { gatewayHttpOrigin } from './gateway-origin.js';

test('gatewayHttpOrigin centralizes gateway browser origin derivation', () => {
  assert.equal(
    gatewayHttpOrigin({ protocol: 'https:', hostname: 'command.local' }),
    'https://command.local:7777',
  );
});

test('gatewayHttpOrigin falls back to local gateway outside the browser', () => {
  assert.equal(gatewayHttpOrigin(), 'http://localhost:7777');
});
