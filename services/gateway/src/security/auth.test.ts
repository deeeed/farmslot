import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  authenticateGatewayClient,
  authorizeHttpRequest,
  createGatewayAuthRuntime,
  GatewayAuthRateLimiter,
  initializeGatewayIdentity,
  resolveGatewayAuth,
  resolveRequestIp,
} from './auth.js';

assert.deepEqual(resolveGatewayAuth({ FARMSLOT_GATEWAY_TOKEN: 'abc' }).mode, 'token');
assert.deepEqual(resolveGatewayAuth({ FARMSLOT_GATEWAY_PASSWORD: 'pw' }).mode, 'password');
assert.throws(() => resolveGatewayAuth({ FARMSLOT_GATEWAY_AUTH_MODE: 'token' }), /requires/);

const runtime = createInitializedRuntime({ FARMSLOT_GATEWAY_TOKEN: 'abc' });
assert.equal(
  authenticateGatewayClient({
    runtime,
    connectParams: { clientKind: 'ui', token: 'wrong' },
    clientIp: '1.2.3.4',
  }).ok,
  false,
);
assert.equal(
  authenticateGatewayClient({
    runtime,
    connectParams: { clientKind: 'ui', token: 'abc' },
    clientIp: '1.2.3.4',
  }).ok,
  true,
);

const limited = {
  ...runtime,
  limiter: new GatewayAuthRateLimiter(1, 60_000),
};
authenticateGatewayClient({
  runtime: limited,
  connectParams: { clientKind: 'ui', token: 'bad' },
  clientIp: '5.6.7.8',
});
const rateLimited = authenticateGatewayClient({
  runtime: limited,
  connectParams: { clientKind: 'ui', token: 'bad' },
  clientIp: '5.6.7.8',
});
assert.equal(rateLimited.rateLimited, true);

// Loopback clients bypass the rate limiter: a valid token authenticates even after a
// prior failure that would lock out a remote IP (max=1). Covers the mapped IPv6 form.
for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
  const loopbackLimited = { ...runtime, limiter: new GatewayAuthRateLimiter(1, 60_000) };
  authenticateGatewayClient({
    runtime: loopbackLimited,
    connectParams: { clientKind: 'ui', token: 'bad' },
    clientIp: ip,
  });
  const loopbackOk = authenticateGatewayClient({
    runtime: loopbackLimited,
    connectParams: { clientKind: 'ui', token: 'abc' },
    clientIp: ip,
  });
  assert.equal(
    loopbackOk.ok,
    true,
    `loopback ${ip} should auth with a valid token despite prior failure`,
  );
  assert.notEqual(loopbackOk.rateLimited, true, `loopback ${ip} should not be rate-limited`);
}

// With proxy headers trusted, clientIp comes from X-Forwarded-For — a forged loopback
// IP must NOT be exempt, so brute-force protection stays on for remote callers.
const proxyRuntime = createInitializedRuntime({
  FARMSLOT_GATEWAY_TOKEN: 'abc',
  FARMSLOT_GATEWAY_TRUST_PROXY_HEADERS: '1',
});
const proxyLimited = { ...proxyRuntime, limiter: new GatewayAuthRateLimiter(1, 60_000) };
authenticateGatewayClient({
  runtime: proxyLimited,
  connectParams: { clientKind: 'ui', token: 'bad' },
  clientIp: '127.0.0.1',
});
const forged = authenticateGatewayClient({
  runtime: proxyLimited,
  connectParams: { clientKind: 'ui', token: 'abc' },
  clientIp: '127.0.0.1',
});
assert.equal(forged.rateLimited, true, 'forged loopback under proxy trust must stay rate-limited');

const cookieRuntime = createInitializedRuntime({ FARMSLOT_GATEWAY_TOKEN: 'cookie-token' });
const cookieResponse = createFakeResponse();
const cookieAuthorized = authorizeHttpRequest({
  runtime: cookieRuntime,
  req: createFakeRequest({
    cookie: 'other=value; farmslot_gateway_credential=cookie-token',
    remoteAddress: '127.0.0.1',
  }),
  res: cookieResponse,
});
assert.equal(cookieAuthorized, true);
assert.equal(cookieResponse.statusCode, undefined);

const encodedCookieResponse = createFakeResponse();
const encodedCookieAuthorized = authorizeHttpRequest({
  runtime: createInitializedRuntime({ FARMSLOT_GATEWAY_TOKEN: 'cookie token with spaces' }),
  req: createFakeRequest({
    cookie: `farmslot_gateway_credential=${encodeURIComponent('cookie token with spaces')}`,
    remoteAddress: '127.0.0.1',
  }),
  res: encodedCookieResponse,
});
assert.equal(encodedCookieAuthorized, true);

const queryTokenResponse = createFakeResponse();
const queryTokenAuthorized = authorizeHttpRequest({
  runtime: createInitializedRuntime({ FARMSLOT_GATEWAY_TOKEN: 'query token' }),
  req: createFakeRequest({
    url: `/api/run-artifact?runId=run-1&path=artifacts%2Fafter.png&token=${encodeURIComponent('query token')}`,
    remoteAddress: '127.0.0.1',
  }),
  res: queryTokenResponse,
});
assert.equal(queryTokenAuthorized, true);

const operator = cookieRuntime.writer.createPrincipal(
  { type: 'person', displayName: 'http-operator' },
  [{ role: 'operator', scope: { kind: 'global' } }],
);
const operatorIssue = cookieRuntime.writer.issueCredential(operator.id, 'http-operator');
const operatorResponse = createFakeResponse();
assert.equal(
  authorizeHttpRequest({
    runtime: cookieRuntime,
    req: createFakeRequest({
      cookie: `farmslot_gateway_credential=${operatorIssue.secret}`,
      remoteAddress: '127.0.0.1',
    }),
    res: operatorResponse,
  }),
  false,
);
assert.equal(operatorResponse.statusCode, 403);

const resolverFailureResponse = createFakeResponse();
const resolveSessionPrincipal = cookieRuntime.resolver.resolveSessionPrincipal;
const consoleError = console.error;
let resolverFailureLog = '';
cookieRuntime.resolver.resolveSessionPrincipal = () => {
  throw new Error('credential store reload failed');
};
console.error = (...args: unknown[]) => {
  resolverFailureLog = args.map(String).join(' ');
};
try {
  assert.equal(
    authorizeHttpRequest({
      runtime: cookieRuntime,
      req: createFakeRequest({
        cookie: 'farmslot_gateway_credential=cookie-token',
        remoteAddress: '127.0.0.1',
      }),
      res: resolverFailureResponse,
    }),
    false,
  );
} finally {
  cookieRuntime.resolver.resolveSessionPrincipal = resolveSessionPrincipal;
  console.error = consoleError;
}
assert.equal(resolverFailureResponse.statusCode, 500);
assert.equal(resolverFailureResponse.body, JSON.stringify({ error: 'Internal error' }));
assert.doesNotMatch(resolverFailureResponse.body, /credential store reload failed/u);
assert.match(resolverFailureLog, /credential store reload failed/u);

const missingCookieResponse = createFakeResponse();
const missingCookieAuthorized = authorizeHttpRequest({
  runtime: cookieRuntime,
  req: createFakeRequest({ cookie: 'other=value', remoteAddress: '127.0.0.1' }),
  res: missingCookieResponse,
});
assert.equal(missingCookieAuthorized, false);
assert.equal(missingCookieResponse.statusCode, 401);

const originalTrustProxyHeaders = process.env.FARMSLOT_GATEWAY_TRUST_PROXY_HEADERS;
try {
  delete process.env.FARMSLOT_GATEWAY_TRUST_PROXY_HEADERS;
  assert.equal(
    resolveRequestIp(
      createFakeRequest({
        remoteAddress: '10.0.0.10',
        forwardedFor: '203.0.113.99, 10.0.0.1',
      }),
    ),
    '10.0.0.10',
  );

  process.env.FARMSLOT_GATEWAY_TRUST_PROXY_HEADERS = '1';
  assert.equal(
    resolveRequestIp(
      createFakeRequest({
        remoteAddress: '10.0.0.10',
        forwardedFor: '203.0.113.99, 10.0.0.1',
      }),
    ),
    '203.0.113.99',
  );
} finally {
  if (originalTrustProxyHeaders === undefined) {
    delete process.env.FARMSLOT_GATEWAY_TRUST_PROXY_HEADERS;
  } else {
    process.env.FARMSLOT_GATEWAY_TRUST_PROXY_HEADERS = originalTrustProxyHeaders;
  }
}

console.log('gateway auth tests passed');

function createInitializedRuntime(env: NodeJS.ProcessEnv) {
  const runtime = createGatewayAuthRuntime({
    ...env,
    FARMSLOT_HOME: mkdtempSync(join(tmpdir(), 'farmslot-auth-test-')),
    GATEWAY_HOST: '127.0.0.1',
  });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  return runtime;
}

function createFakeRequest(params: {
  cookie?: string;
  forwardedFor?: string;
  remoteAddress?: string;
  url?: string;
}): IncomingMessage {
  return {
    url: params.url,
    headers: {
      ...(params.cookie ? { cookie: params.cookie } : {}),
      ...(params.forwardedFor ? { 'x-forwarded-for': params.forwardedFor } : {}),
    },
    socket: { remoteAddress: params.remoteAddress ?? '127.0.0.1' },
  } as IncomingMessage;
}

function createFakeResponse(): ServerResponse & { statusCode?: number; body?: string } {
  const response = {
    writeHead(statusCode: number) {
      response.statusCode = statusCode;
      return response;
    },
    end(body?: string) {
      response.body = body;
      return response;
    },
  } as ServerResponse & { statusCode?: number; body?: string };
  return response;
}
