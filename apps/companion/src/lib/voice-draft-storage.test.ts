import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPersistedVoiceDraft,
  parsePersistedVoiceDraft,
  voiceDraftStorageKey,
} from './voice-draft-storage';

test('voiceDraftStorageKey encodes slot ids for AsyncStorage keys', () => {
  assert.equal(
    voiceDraftStorageKey('runner-local/example-audio 1'),
    '@farmslot:voiceCopilot:draft:runner-local%2Fexample-audio%201',
  );
});

test('buildPersistedVoiceDraft trims text and skips empty drafts', () => {
  const now = new Date('2026-05-20T00:00:00.000Z');

  assert.deepEqual(
    buildPersistedVoiceDraft({
      slotId: ' runner-local-example-audio-1 ',
      transcript: ' please status ',
      draft: ' Please report status. ',
      now,
    }),
    {
      slotId: 'runner-local-example-audio-1',
      transcript: 'please status',
      draft: 'Please report status.',
      updatedAt: '2026-05-20T00:00:00.000Z',
    },
  );
  assert.equal(
    buildPersistedVoiceDraft({
      slotId: 'runner-local-example-audio-1',
      transcript: ' ',
      draft: '',
    }),
    null,
  );
});

test('parsePersistedVoiceDraft restores matching slot drafts', () => {
  const raw = JSON.stringify({
    slotId: 'runner-local-example-audio-1',
    transcript: ' raw ',
    draft: ' formatted ',
    updatedAt: '2026-05-20T00:00:00.000Z',
  });

  assert.deepEqual(parsePersistedVoiceDraft(raw, 'runner-local-example-audio-1'), {
    slotId: 'runner-local-example-audio-1',
    transcript: 'raw',
    draft: 'formatted',
    updatedAt: '2026-05-20T00:00:00.000Z',
  });
});

test('parsePersistedVoiceDraft ignores malformed and wrong-slot drafts', () => {
  assert.equal(parsePersistedVoiceDraft('{', 'runner-local-example-audio-1'), null);
  assert.equal(
    parsePersistedVoiceDraft(
      JSON.stringify({ slotId: 'other-slot', transcript: 'raw', draft: 'formatted' }),
      'runner-local-example-audio-1',
    ),
    null,
  );
});
