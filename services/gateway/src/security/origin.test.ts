import assert from 'node:assert/strict';

import { isGatewayOriginAllowed } from './origin.js';

assert.equal(isGatewayOriginAllowed(undefined, 'localhost:7777'), true);
assert.equal(isGatewayOriginAllowed('https://farmslot.io', 'localhost:7777'), true);
assert.equal(isGatewayOriginAllowed('http://localhost:5174', 'localhost:7777'), true);
assert.equal(isGatewayOriginAllowed('http://127.0.0.1:5174', 'localhost:7777'), true);
assert.equal(isGatewayOriginAllowed('http://localhost:7777', 'localhost:7777'), true);
assert.equal(isGatewayOriginAllowed('https://evil.example', 'localhost:7777'), false);
assert.equal(isGatewayOriginAllowed('not an origin', 'localhost:7777'), false);

const previous = process.env.FARMSLOT_GATEWAY_ALLOWED_ORIGINS;
try {
  process.env.FARMSLOT_GATEWAY_ALLOWED_ORIGINS = 'https://lab.example';
  assert.equal(isGatewayOriginAllowed('https://lab.example', 'localhost:7777'), true);
} finally {
  if (previous === undefined) delete process.env.FARMSLOT_GATEWAY_ALLOWED_ORIGINS;
  else process.env.FARMSLOT_GATEWAY_ALLOWED_ORIGINS = previous;
}

console.log('gateway origin tests passed');
