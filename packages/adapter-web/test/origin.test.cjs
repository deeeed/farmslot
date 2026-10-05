'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { isAppTopFrameContext, isAppUrl, shortUrl } = require('../src/origin.cjs');

describe('origin', () => {
  it('compares exact origins, never prefixes', () => {
    assert.equal(isAppUrl('http://localhost:3000/order/ETH', 'http://localhost:3000'), true);
    assert.equal(isAppUrl('http://localhost:30001/', 'http://localhost:3000'), false);
    assert.equal(isAppUrl('http://localhost:3000.evil.test/', 'http://localhost:3000'), false);
    assert.equal(isAppUrl('about:blank', 'http://localhost:3000'), false);
    assert.equal(isAppUrl('not a url', 'http://localhost:3000'), false);
  });

  it('accepts a context only in the app top frame while it shows an app URL', () => {
    const scope = {
      targetId: 'TOP',
      appOrigin: 'http://localhost:9341',
      committedUrl: 'http://localhost:9341/order/ETH',
    };
    const context = (origin, frameId, isDefault = true) => ({
      origin,
      auxData: { frameId, isDefault },
    });
    assert.equal(isAppTopFrameContext(context('http://localhost:9341', 'TOP'), scope), true);
    assert.equal(isAppTopFrameContext(context('http://localhost:9341', 'IFRAME'), scope), false);
    assert.equal(isAppTopFrameContext(context('https://evil.test', 'TOP'), scope), false);
    assert.equal(
      isAppTopFrameContext(context('http://localhost:9341', 'TOP', false), scope),
      false,
    );
    assert.equal(
      isAppTopFrameContext(context('http://localhost:9341', 'TOP'), {
        ...scope,
        committedUrl: 'about:blank',
      }),
      false,
    );
    assert.equal(isAppTopFrameContext(undefined, scope), false);
  });

  it('shortens a URL to its scheme, host and path', () => {
    assert.equal(
      shortUrl('https://api.example.test:8443/info?key=secret#x'),
      'https://api.example.test:8443/info',
    );
    assert.equal(shortUrl('x'.repeat(200)), 'x'.repeat(120));
  });
});
