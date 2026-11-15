import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { litText } from '../../testing/lit-text.js';

mock.module('../diff-viewer/diff-review.js', { namedExports: {} });
const gateway = await import('../../utils/gateway-origin.js');
let response: Response;
mock.module('../../utils/gateway-origin.js', {
  namedExports: { ...gateway, gatewayHttpFetch: async () => response },
});
const { MediaLightbox } = await import('./media-lightbox.js');

interface LogView {
  _logUrl: string;
  _logLoading: boolean;
  _logText: string;
  _logError: string;
  _logFollow: boolean;
  _refreshLog(url: string): Promise<void>;
  _renderLogItem(item: { path: string; url: string }): unknown;
}
const item = { path: 'artifacts/operations/operation.log', url: '/log' };
function fixture(): LogView {
  return Object.assign(Object.create(MediaLightbox.prototype), {
    requestUpdate: () => undefined,
    _logUrl: item.url,
    _logLoading: false,
    _logText: '',
    _logError: '',
    _logFollow: false,
  });
}

test('existing empty logs, including empty suffix ranges, show an empty state', async () => {
  for (response of [
    new Response('', { status: 200 }),
    new Response('', { status: 416, headers: { 'Content-Range': 'bytes */0' } }),
  ]) {
    const view = fixture();
    await view._refreshLog(item.url);
    const text = litText(view._renderLogItem(item));
    assert.equal(view._logError, '');
    assert.match(text, /Log is empty/);
    assert.doesNotMatch(text, /Log unavailable/);
  }
});

test('missing logs show unavailable without also claiming an empty log', async () => {
  response = new Response('not found', { status: 404 });
  const view = fixture();
  await view._refreshLog(item.url);
  const text = litText(view._renderLogItem(item));
  assert.match(text, /Log unavailable: File not found \(HTTP 404\)/);
  assert.doesNotMatch(text, /No output recorded|Log is empty/);
});

test('a failed refresh preserves recorded output and does not call it empty', async () => {
  response = new Response('', { status: 503 });
  const view = fixture();
  view._logText = 'earlier output';
  await view._refreshLog(item.url);
  const text = litText(view._renderLogItem(item));
  assert.match(text, /HTTP 503/);
  assert.match(text, /earlier output/);
  assert.doesNotMatch(text, /No output recorded|Log is empty/);
});
