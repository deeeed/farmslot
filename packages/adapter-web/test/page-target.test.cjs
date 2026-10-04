'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { selectPageTarget } = require('../src/page-target.cjs');

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
