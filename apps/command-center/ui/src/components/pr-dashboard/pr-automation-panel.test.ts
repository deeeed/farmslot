import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

import { Methods } from '@farmslot/protocol';

import {
  prDraftScope,
  type PRStoredDraft,
  readPRDraft,
  writePRDraft,
} from './pr-automation-draft-store.js';

// Node-only browser substitutes; no live gateway or browser state is modified.
const original = new Map(
  ['window', 'location', 'localStorage'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
const address = { hash: '#prs', origin: 'http://localhost', hostname: 'localhost' };
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
};
for (const [key, value] of Object.entries({
  location: address,
  localStorage: storage,
  window: { addEventListener() {}, removeEventListener() {} },
}))
  Object.defineProperty(globalThis, key, { configurable: true, value });
after(() => {
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const gateway = { gatewayUrl: 'ws://localhost:1234', authenticatedPrincipalId: 'owner' };
mock.module('../../gateway-client.js', { namedExports: { gateway } });
const { PRAutomationPanel } = await import('./pr-automation-panel.js');

type PanelTestAccess = {
  controller: { mutate: () => Promise<unknown> };
  openEditor: (editor: 'team') => void;
  onHashChange: () => void;
  restoreRoute: () => void;
  mutateEditor: (method: string, params: unknown) => Promise<unknown>;
  finishEditor: () => void;
  editor: string | undefined;
  draftId: string | undefined;
};
const otherDraft: PRStoredDraft = {
  version: 1,
  payload: {
    kind: 'rule',
    value: {
      repository: '',
      config: {
        name: 'Unsaved second rule',
        teamId: 'team',
        predicate: { kind: 'all', items: [] },
        actions: [{ kind: 'notify' }],
        pollIntervalMs: 60000,
        maxAdmissionsPerScan: 1,
        rereviewOnHeadChange: false,
      },
    },
  },
};
for (const restoreBeforeSaveFinishes of [false, true]) {
  test(`history navigation preserves the other draft when save finishes ${restoreBeforeSaveFinishes ? 'after' : 'before'} restoration`, async () => {
    address.hash = '#prs?prTab=rules&prEditor=team';
    const scope = prDraftScope(gateway.gatewayUrl, gateway.authenticatedPrincipalId)!;
    writePRDraft(storage, scope, 'other-draft', otherDraft);
    const panel = new PRAutomationPanel() as unknown as PanelTestAccess;
    Object.defineProperty(panel, 'isConnected', { value: true });
    panel.openEditor('team');
    let finishSave!: (result: unknown) => void;
    panel.controller.mutate = () =>
      new Promise((resolve) => {
        finishSave = resolve;
      });
    const save = panel.mutateEditor(Methods.PR_TEAM_SAVE, {}).then((result) => {
      if (result) panel.finishEditor();
      return result;
    });
    address.hash = '#prs?prTab=rules&prEditor=rule&prDraft=other-draft';
    panel.onHashChange();
    if (restoreBeforeSaveFinishes) panel.restoreRoute();
    finishSave({ id: 'saved-first-team' });
    assert.equal(await save, undefined, 'Old save completion must not affect the navigated editor');
    if (!restoreBeforeSaveFinishes) panel.restoreRoute();
    assert.equal(panel.editor, 'rule');
    assert.equal(panel.draftId, 'other-draft');
    assert.deepEqual(readPRDraft(storage, scope, 'other-draft'), otherDraft);
  });
}
