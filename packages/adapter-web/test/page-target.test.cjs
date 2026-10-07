'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { selectExtensionTarget, selectPageTarget } = require('../src/page-target.cjs');

describe('selectPageTarget', () => {
  const unrelated = { id: 'unrelated', type: 'page', url: 'https://example.com/#prs' };
  const board = { id: 'board', type: 'page', url: 'http://localhost:5175/#prs' };
  const fleet = { id: 'fleet', type: 'page', url: 'http://localhost:5175/#fleet' };
  const origin = 'http://localhost:5175';

  it('takes the first page on the origin when no hash is asked for', () => {
    assert.equal(selectPageTarget([unrelated, board], { origin }).id, 'board');
  });

  it('prefers the page whose URL carries the hash, with or without #', () => {
    assert.equal(selectPageTarget([unrelated, fleet, board], { origin, hash: '#prs' }).id, 'board');
    assert.equal(selectPageTarget([unrelated, fleet, board], { origin, hash: 'prs' }).id, 'board');
    assert.equal(selectPageTarget([fleet], { origin, hash: '#prs' }).id, 'fleet');
  });

  it('returns null without a page on the origin, skipping non-pages and unparseable URLs', () => {
    const worker = { id: 'worker', type: 'service_worker', url: 'http://localhost:5175/sw.js' };
    const internal = { id: 'internal', type: 'page', url: 'not a url' };
    assert.equal(
      selectPageTarget([unrelated, worker, internal, { type: 'page' }], { origin }),
      null,
    );
  });
});

describe('selectExtensionTarget', () => {
  const paths = ['/home.html', '/sidepanel.html'];
  const target = (targetId, url, type = 'page') => ({ targetId, type, url });

  it('selects an open extension UI page instead of background targets', () => {
    const wallet = target('wallet', 'chrome-extension://ext/home.html');
    assert.deepEqual(
      selectExtensionTarget(
        [
          target('background', 'chrome-extension://ext/background.html', 'other'),
          wallet,
          target('sidepanel', 'chrome-extension://ext/sidepanel.html'),
          target('unrelated', 'https://example.com/'),
        ],
        'ext',
        { paths },
      ),
      wallet,
    );
  });

  it('fails closed when the first matching path has several renderers', () => {
    assert.equal(
      selectExtensionTarget(
        [
          target('wallet-1', 'chrome-extension://ext/home.html'),
          target('wallet-2', 'chrome-extension://ext/home.html#/settings'),
          target('sidepanel', 'chrome-extension://ext/sidepanel.html'),
        ],
        'ext',
        { paths },
      ),
      null,
    );
  });

  it('falls back to the next path only when no earlier path is open', () => {
    const sidepanel = target('sidepanel', 'chrome-extension://ext/sidepanel.html');
    assert.deepEqual(
      selectExtensionTarget(
        [
          sidepanel,
          target('options', 'chrome-extension://ext/options.html'),
          target('other-extension', 'chrome-extension://other/home.html'),
        ],
        'ext',
        { paths },
      ),
      sidepanel,
    );
  });

  it('reads /json entries and skips workers, unparseable URLs and non-lists', () => {
    assert.deepEqual(
      selectExtensionTarget(
        [
          { id: 'worker', type: 'service_worker', url: 'chrome-extension://ext/home.html' },
          { id: 'internal', type: 'page', url: 'not a url' },
          { id: 'wallet', type: 'page', url: 'chrome-extension://ext/home.html' },
        ],
        'ext',
        { paths },
      ),
      target('wallet', 'chrome-extension://ext/home.html'),
    );
    assert.equal(selectExtensionTarget(undefined, 'ext', { paths }), null);
  });
});
