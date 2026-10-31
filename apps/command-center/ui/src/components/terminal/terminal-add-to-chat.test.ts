import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeWorkerViewTarget } from '@farmslot/review-dispatch';

import { litBindings, litText } from '../../testing/lit-text.js';

import { renderTmuxToolbar, type TmuxToolbarContext } from './terminal-view-renderers.js';

const target = (contextId: string, readOnly: boolean): NativeWorkerViewTarget => ({
  runId: 'run',
  contextId,
  label: contextId,
  readOnly,
  binding: {
    sessionId: `session-${contextId}`,
    executionNodeId: 'macpro',
    ownerPrincipalId: 'owner',
    generation: 'generation',
    leaseId: 'lease',
    commandId: 'command',
  },
});
const tabs = [
  { key: 'live', label: 'rev-claude native', target: target('live', false) },
  { key: 'history', label: 'rev-claude native · History', target: target('history', true) },
];
const toolbar = (selectMode: boolean, hasSelection: boolean, added: string[] = []) =>
  renderTmuxToolbar({
    isWorkerTarget: false,
    mode: 'pty',
    selectMode,
    windows: [],
    renaming: false,
    renameValue: '',
    setRenameValue: () => undefined,
    startRename: () => undefined,
    submitRename: () => undefined,
    cancelRename: () => undefined,
    toggleSelectMode: () => undefined,
    sendRawKeys: () => undefined,
    tmuxAction: () => undefined,
    nativeWorkers: tabs,
    hasSelection,
    addToChat: (tab) => added.push(tab.key),
  } satisfies TmuxToolbarContext);

test('a terminal offers its selection to each writable native conversation, once text is selected', () => {
  const text = litText(toolbar(true, true));
  assert.equal(text.split('Add to rev-claude native').length - 1, 1, 'history tabs take no input');
  // Present before anything is selected, so the toolbar does not shift when a selection starts.
  assert.deepEqual(litBindings(toolbar(false, false), '?disabled='), [true]);
  assert.deepEqual(litBindings(toolbar(true, false), '?disabled='), [true]);
  assert.deepEqual(litBindings(toolbar(true, true), '?disabled='), [false]);
  // Every other button in this toolbar is a no-op here, so clicking them all adds exactly once.
  const added: string[] = [];
  for (const click of litBindings(toolbar(true, true, added), '@click=')) (click as () => void)();
  assert.deepEqual(added, ['live']);
});
