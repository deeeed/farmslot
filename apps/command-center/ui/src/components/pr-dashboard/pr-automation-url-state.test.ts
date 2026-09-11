import assert from 'node:assert/strict';
import test from 'node:test';

import {
  prDraftScope,
  type PRStoredDraft,
  readPRDraft,
  writePRDraft,
} from './pr-automation-draft-store.js';
import { buildPRAutomationUrl, parsePRAutomationUrl } from './pr-automation-url-state.js';

test('PR configuration URLs preserve layout and filters, and round-trip editor identity', () => {
  const state = {
    tab: 'rules' as const,
    editor: 'team' as const,
    target: 'team-1',
    draft: 'draft-1',
    history: true,
  };
  const hash = buildPRAutomationUrl(
    state,
    '#prs?layout=list&projects=mobile&repo=org%2Fapp&pr=12',
  )!;
  assert.deepEqual(parsePRAutomationUrl(hash), state);
  assert(hash.includes('layout=list'));
  assert(hash.includes('projects=mobile'));
  assert(hash.includes('repo=org%2Fapp'));
  const closed = buildPRAutomationUrl({ tab: 'reviews', history: false }, hash)!;
  assert(!closed.includes('prDraft'));
  assert(!closed.includes('prEditor'));
  assert(closed.includes('layout=list'));
  assert.equal(parsePRAutomationUrl('#runs'), null);
});

test('local draft scope follows gateway and authenticated principal, never URL credentials', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const scope = prDraftScope('ws://user:secret@localhost:7777/ws?token=private', 'owner')!;
  assert(!scope.includes('secret'));
  assert(!scope.includes('private'));
  assert.equal(prDraftScope('ws://localhost:7777/ws', null), null);
  const record: PRStoredDraft = {
    version: 1,
    payload: {
      kind: 'rule',
      value: {
        config: {
          name: 'Draft',
          teamId: 'team-1',
          predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
          actions: [{ kind: 'review', autoStart: false }],
          pollIntervalMs: 300000,
          maxAdmissionsPerScan: 1,
          rereviewOnHeadChange: false,
        },
        repository: '',
      },
    },
  };
  writePRDraft(storage, scope, 'draft-1', record);
  assert.deepEqual(readPRDraft(storage, scope, 'draft-1'), record);
  assert.equal(
    readPRDraft(storage, prDraftScope('ws://localhost:7777/ws', 'other')!, 'draft-1'),
    null,
  );
  assert.equal(
    readPRDraft(storage, prDraftScope('ws://localhost:7778/ws', 'owner')!, 'draft-1'),
    null,
  );
});
