import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPersistedVoiceDraft,
  parsePersistedVoiceDraft,
  voiceDraftPane,
  voiceDraftStorageKey,
} from './voice-draft-storage';

test('a draft belongs to its pane, and the pane key is safe for AsyncStorage', () => {
  const pane = voiceDraftPane({ nodeId: 'mini', paneId: '%12', target: 'slot-1:dev.0' });
  assert.equal(pane, 'mini:%12');
  assert.equal(voiceDraftPane({ nodeId: 'mini', target: 'slot-1:dev.0' }), 'mini:slot-1:dev.0');
  assert.equal(voiceDraftStorageKey(pane), '@farmslot:terminal:draft:mini%3A%2512');
});

test('buildPersistedVoiceDraft trims text and skips empty drafts', () => {
  const now = new Date('2026-05-20T00:00:00.000Z');

  assert.deepEqual(
    buildPersistedVoiceDraft({
      pane: ' mini:%12 ',
      transcript: ' please status ',
      draft: ' Please report status. ',
      now,
    }),
    {
      pane: 'mini:%12',
      transcript: 'please status',
      draft: 'Please report status.',
      updatedAt: '2026-05-20T00:00:00.000Z',
    },
  );
  assert.equal(buildPersistedVoiceDraft({ pane: 'mini:%12', transcript: ' ', draft: '' }), null);
});

test('parsePersistedVoiceDraft restores the same pane only', () => {
  const raw = JSON.stringify({
    pane: 'mini:%12',
    transcript: ' raw ',
    draft: ' formatted ',
    updatedAt: '2026-05-20T00:00:00.000Z',
  });

  assert.deepEqual(parsePersistedVoiceDraft(raw, 'mini:%12'), {
    pane: 'mini:%12',
    transcript: 'raw',
    draft: 'formatted',
    updatedAt: '2026-05-20T00:00:00.000Z',
  });
  assert.equal(parsePersistedVoiceDraft(raw, 'mini:%13'), null);
});

test('parsePersistedVoiceDraft ignores malformed and old per-slot drafts', () => {
  assert.equal(parsePersistedVoiceDraft('{', 'mini:%12'), null);
  assert.equal(
    parsePersistedVoiceDraft(
      JSON.stringify({ slotId: 'mini:%12', transcript: 'raw', draft: 'formatted' }),
      'mini:%12',
    ),
    null,
  );
});
