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

// The LAN page is http://lan.example:5175. The socket it opens is ws://lan.example:7801/ws.
const lanOrigin = 'http://lan.example:5175';
const lanGatewayHost = 'lan.example:7801';
const previousHosts = process.env.FARMSLOT_UI_ALLOWED_HOSTS;
const previousPort = process.env.VITE_PORT;
const previousNodeEnv = process.env.NODE_ENV;
const previousDevOrigins = process.env.FARMSLOT_DEV_UI_ORIGINS;
try {
  delete process.env.FARMSLOT_UI_ALLOWED_HOSTS;
  delete process.env.VITE_PORT;
  delete process.env.NODE_ENV;
  delete process.env.FARMSLOT_DEV_UI_ORIGINS;
  assert.equal(isGatewayOriginAllowed(lanOrigin, lanGatewayHost), false);
  process.env.FARMSLOT_UI_ALLOWED_HOSTS = 'lan.example, other.example';
  process.env.VITE_PORT = '5175';
  assert.equal(isGatewayOriginAllowed(lanOrigin, lanGatewayHost), false);
  process.env.NODE_ENV = 'development';
  assert.equal(isGatewayOriginAllowed(lanOrigin, lanGatewayHost), false);
  process.env.FARMSLOT_DEV_UI_ORIGINS = 'true';
  assert.equal(isGatewayOriginAllowed(lanOrigin, lanGatewayHost), false);
  process.env.FARMSLOT_DEV_UI_ORIGINS = '1';
  process.env.VITE_PORT = '5174';
  assert.equal(isGatewayOriginAllowed(lanOrigin, lanGatewayHost), false);
  process.env.VITE_PORT = '5175';
  assert.equal(isGatewayOriginAllowed(lanOrigin, lanGatewayHost), true);
  delete process.env.NODE_ENV;
  assert.equal(isGatewayOriginAllowed(lanOrigin, lanGatewayHost), true);
  assert.equal(isGatewayOriginAllowed('http://other.example:5175', lanGatewayHost), true);
  assert.equal(isGatewayOriginAllowed('http://evil.example:5175', lanGatewayHost), false);
  assert.equal(isGatewayOriginAllowed('https://lan.example:5175', lanGatewayHost), false);
  process.env.FARMSLOT_UI_ALLOWED_HOSTS = '.lan.example, *, lan.example:5175';
  assert.equal(isGatewayOriginAllowed(lanOrigin, lanGatewayHost), false);
  assert.equal(isGatewayOriginAllowed('http://sub.lan.example:5175', lanGatewayHost), false);
  process.env.FARMSLOT_UI_ALLOWED_HOSTS = '*';
  assert.equal(isGatewayOriginAllowed(lanOrigin, lanGatewayHost), false);
  process.env.FARMSLOT_GATEWAY_ALLOWED_ORIGINS = lanOrigin;
  delete process.env.FARMSLOT_UI_ALLOWED_HOSTS;
  delete process.env.VITE_PORT;
  delete process.env.NODE_ENV;
  delete process.env.FARMSLOT_DEV_UI_ORIGINS;
  assert.equal(isGatewayOriginAllowed(lanOrigin, lanGatewayHost), true);
  assert.equal(isGatewayOriginAllowed('http://evil.example:5175', lanGatewayHost), false);
} finally {
  if (previousHosts === undefined) delete process.env.FARMSLOT_UI_ALLOWED_HOSTS;
  else process.env.FARMSLOT_UI_ALLOWED_HOSTS = previousHosts;
  if (previousPort === undefined) delete process.env.VITE_PORT;
  else process.env.VITE_PORT = previousPort;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDevOrigins === undefined) delete process.env.FARMSLOT_DEV_UI_ORIGINS;
  else process.env.FARMSLOT_DEV_UI_ORIGINS = previousDevOrigins;
  if (previous === undefined) delete process.env.FARMSLOT_GATEWAY_ALLOWED_ORIGINS;
  else process.env.FARMSLOT_GATEWAY_ALLOWED_ORIGINS = previous;
}

console.log('gateway origin tests passed');
