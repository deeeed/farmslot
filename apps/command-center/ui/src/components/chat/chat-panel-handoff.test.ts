import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { litBindings, litText } from '../../testing/lit-text.js';

let scope = 'scope-a';
const gateway = {
  connectionState: 'connected',
  authenticatedConnection: { capabilities: { conversationStreaming: 1 as number | undefined } },
};
mock.module('./native-session-view.js', { namedExports: {} });
mock.module('./chat-message.js', { namedExports: {} });
mock.module('../shared/review-dispatch-picker.js', { namedExports: {} });
mock.module('./native-session-observation.js', {
  namedExports: { observeNativeArchiveResource: () => () => undefined },
});
mock.module('../../gateway-client.js', {
  namedExports: { gateway },
});
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceCache: () => undefined,
    getResourceWorkspaceKey: () => scope,
    getResourceWorkspaceAccess: () => 'farm',
    subscribeResourceCache: () => () => undefined,
  },
});
mock.module('../../utils/url-state.js', {
  namedExports: {
    hashParams: () => new URLSearchParams('copilotTarget=agent'),
    navigateHash: () => undefined,
    buildHash: () => '#copilot',
    hashRoute: () => 'copilot',
  },
});

const { ChatPanel } = await import('./chat-panel.js');

test('a cold target switch retains its exact unsent draft until the destination mounts', async () => {
  const panel = new ChatPanel();
  const draft = 'Keep the complete unsent instruction';
  let child: object | null = { takeUnsentDraft: () => draft };
  Object.defineProperty(panel, 'querySelector', { value: () => child });
  Reflect.set(panel, 'targetChoice', 'agent');
  await Reflect.get(panel, 'chooseTarget').call(panel, 'copilot');
  child = null;
  await Reflect.get(panel, 'deliverHandoff').call(panel);
  assert.equal(Reflect.get(panel, 'pendingHandoff')?.text, draft);
  let prepared = '',
    sends = 0;
  child = {
    isConnected: true,
    updateComplete: Promise.resolve(true),
    prepareUnsentDraft: (text: string) => {
      prepared = text;
    },
    submitPrompt: async () => {
      sends++;
    },
  };
  await Reflect.get(panel, 'deliverHandoff').call(panel);
  assert.equal(prepared, draft);
  assert.equal(sends, 0);
  assert.equal(Reflect.get(panel, 'pendingHandoff'), undefined);
});

test('a pending draft cannot cross an account change while its destination loads', async () => {
  const panel = new ChatPanel();
  const prepared: string[] = [];
  Object.defineProperty(panel, 'querySelector', {
    value: () => ({
      isConnected: true,
      updateComplete: Promise.resolve(true),
      prepareUnsentDraft: (text: string) => prepared.push(text),
    }),
  });
  Reflect.set(panel, 'pendingHandoff', {
    scope,
    target: 'copilot',
    text: 'Private draft',
    submit: false,
  });
  scope = 'scope-b';
  try {
    await Reflect.get(panel, 'deliverHandoff').call(panel);
    assert.deepEqual(prepared, []);
    assert.equal(Reflect.get(panel, 'pendingHandoff'), undefined);
  } finally {
    scope = 'scope-a';
  }
});

test('an explicit submit waits for current conversation authority and is delivered once', async () => {
  const panel = new ChatPanel();
  let ready = false,
    sends = 0;
  Object.defineProperty(panel, 'runtimeQuery', { value: { ready: true } });
  Object.defineProperty(panel, 'querySelector', {
    value: () => ({
      isConnected: true,
      updateComplete: Promise.resolve(true),
      get canSubmitPrompt() {
        return ready;
      },
      submitPrompt: async () => {
        sends++;
      },
    }),
  });
  await panel.submitPrompt('Diagnose this run');
  await Reflect.get(panel, 'deliverHandoff').call(panel);
  assert.equal(sends, 0);
  assert.equal(Reflect.get(panel, 'pendingHandoff')?.text, 'Diagnose this run');
  ready = true;
  await Reflect.get(panel, 'deliverHandoff').call(panel);
  await Reflect.get(panel, 'deliverHandoff').call(panel);
  assert.equal(sends, 1);
});

test('settings keep drafts and action availability during a superseded background read', () => {
  const panel = new ChatPanel();
  const query = Reflect.get(panel, 'runtimeQuery');
  const session = {
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'low',
    autostart: false,
    status: 'stopped',
  };
  const current = { status: 'ready', data: { session } };
  query.onChange(current);
  const picker = Reflect.get(panel, 'picker');
  picker.setSequence([{ runner: 'codex', model: 'gpt-6-luna', effort: 'low', mode: 'cold' }]);
  Reflect.set(panel, 'configurationDirty', true);
  Reflect.set(panel, 'autostart', true);
  query.state = {
    ...current,
    status: 'stale',
    error: { code: 'RESOURCE_OBSERVATION_CHANGED', message: 'Workspace changed during read' },
  };
  Object.defineProperty(query, 'actable', { value: true });
  query.onChange(query.state);
  assert.equal(picker.selection.model, 'gpt-6-luna');
  assert.equal(Reflect.get(panel, 'autostart'), true);
  assert.doesNotMatch(litText(panel.render()), /Workspace changed during read/);
  Reflect.set(panel, 'settings', true);
  assert(litBindings(panel.render(), '?disabled=').every((disabled) => disabled === false));
});

test('an older gateway has a stable update notice and cannot launch or change the native copilot', () => {
  const panel = new ChatPanel();
  Reflect.set(panel, 'settings', true);
  const query = Reflect.get(panel, 'runtimeQuery');
  Object.defineProperty(query, 'actable', { value: true });
  query.state = {
    status: 'stale',
    error: {
      code: 'RESOURCE_OBSERVATION_UNAVAILABLE',
      message: 'Workspace source or identity changed during the read',
    },
  };
  gateway.authenticatedConnection.capabilities.conversationStreaming = undefined;
  try {
    const rendered = panel.render();
    assert.match(litText(rendered), /gateway update/i);
    assert.doesNotMatch(litText(rendered), /Workspace source or identity changed during the read/);
    assert(
      litBindings(rendered, '?disabled=')
        .slice(1)
        .every((disabled) => disabled === true),
    );
    assert.match(litText(rendered), /Saved conversations/);
  } finally {
    gateway.authenticatedConnection.capabilities.conversationStreaming = 1;
  }
});

test('action preflight waits for a current settings read before capturing its owner', async () => {
  const panel = new ChatPanel();
  let checked = false;
  const query = Reflect.get(panel, 'runtimeQuery');
  query.requireCurrent = async () => {
    checked = true;
  };
  const owns = await Reflect.get(panel, 'ownerGuard').call(panel);
  assert.equal(checked, true);
  assert.equal(owns(), true);
  scope = 'replacement-scope';
  try {
    assert.equal(owns(), false);
  } finally {
    scope = 'scope-a';
  }
});

test('unchanged runtime refreshes preserve the runner picker row identity', () => {
  const panel = new ChatPanel();
  const query = Reflect.get(panel, 'runtimeQuery');
  const session = {
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'low',
    autostart: false,
    status: 'stopped',
  };
  query.onChange({ status: 'ready', data: { session } });
  const picker = Reflect.get(panel, 'picker');
  const row = picker.rows[0].id;
  query.onChange({ status: 'stale', data: { session: { ...session } } });
  assert.equal(picker.rows[0].id, row);
});

test('a persistent reconnecting runtime keeps its actual failure reason visible', () => {
  const panel = new ChatPanel();
  Reflect.set(panel, 'runtime', {
    status: 'reconnecting',
    terminalReason: 'Native execution owner changed',
  });
  assert.match(litText(panel.render()), /Native execution owner changed/);
});

test('dangerous confirmation preflights a stale read without changing the displayed fingerprint', async () => {
  const panel = new ChatPanel();
  const query = Reflect.get(panel, 'runtimeQuery');
  const binding = {
    fingerprint: 'displayed-fingerprint',
    typedPhrase: 'ENABLE DANGEROUS CO-PILOT',
    warning: 'Existing safety warning',
    checkout: '/owned',
    branch: 'feature',
    head: 'a',
    dirtyFileCount: 0,
    runner: 'codex',
    model: 'gpt-6.1-sol',
    safetyTier: 'dangerous',
  };
  Reflect.set(panel, 'runtime', { status: 'stopped', dangerousLaunch: binding });
  Reflect.set(panel, 'dangerous', true);
  Reflect.set(panel, 'phrase', binding.typedPhrase);
  query.state = { status: 'stale', data: { session: { dangerousLaunch: binding } } };
  query.requireReady = () => {
    throw new Error('stale read must preflight');
  };
  let fresh = false;
  query.requireCurrent = async () => {
    fresh = true;
    Reflect.set(panel, 'runtime', {
      status: 'stopped',
      dangerousLaunch: { ...binding, fingerprint: 'unseen-new-fingerprint' },
    });
  };
  let fingerprint: string | undefined;
  Reflect.set(panel, 'start', async (params: { confirmation: { fingerprint: string } }) => {
    assert.equal(fresh, true);
    fingerprint = params.confirmation.fingerprint;
  });
  const confirm = litBindings(panel.render(), '@click=').at(-1);
  assert(typeof confirm === 'function');
  await confirm();
  assert.equal(fingerprint, binding.fingerprint);
});
