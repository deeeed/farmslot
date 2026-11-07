import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let scope = 'scope-a';
mock.module('./native-session-view.js', { namedExports: {} });
mock.module('./chat-message.js', { namedExports: {} });
mock.module('../shared/review-dispatch-picker.js', { namedExports: {} });
mock.module('./native-session-observation.js', {
  namedExports: { observeNativeArchiveResource: () => () => undefined },
});
mock.module('../../gateway-client.js', {
  namedExports: { gateway: { connectionState: 'connected' } },
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
