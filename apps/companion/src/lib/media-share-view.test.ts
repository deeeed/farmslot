import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSharedViewLink } from '@farmslot/protocol/surfaces/view-links';

import { mediaShareView } from './media-share-view';

test('a changed video selection refuses the opening artifact until a new observed item opens', () => {
  const opened = { runId: 'run-A', path: 'recording-A.mp4', traceIndex: 3 };
  const initial = mediaShareView(opened, false);
  assert(initial);
  assert.equal(
    resolveSharedViewLink({ companion: initial }, 'https://cc.example/').status,
    'available',
  );
  const changed = mediaShareView(opened, true);
  assert(changed);
  const refused = resolveSharedViewLink({ companion: changed }, 'https://cc.example/');
  assert.equal(refused.status, 'unavailable');
  if (refused.status === 'unavailable')
    assert.match(refused.message, /selected recording or occurrence/);
  const reopened = mediaShareView(
    { runId: 'run-A', path: 'recording-B.mp4', traceIndex: 7 },
    false,
  );
  assert(reopened);
  const result = resolveSharedViewLink({ companion: reopened }, 'https://cc.example/');
  assert(result.status === 'available');
  assert.match(result.route, /artifact=recording-B.mp4/);
  assert.match(result.route, /artifactTrace=7/);
});
