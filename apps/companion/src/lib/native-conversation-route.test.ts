import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import React from 'react';

import type { NativeSessionReadResult } from '@farmslot/protocol';
import type { ResourceQuery, ResourceQueryState } from '@farmslot/protocol/client-cache';

import type { NativeConversationParams } from '../features/native-conversation/use-native-conversation-controller';

import type { WorkspaceAccess } from './workspace-access';

let access: WorkspaceAccess = 'none';
let remembered: WorkspaceAccess = 'native';
let status = 'disconnected';
let connectionGeneration = 0;
let hasClient = false;
const client = {
  get connectionGeneration() {
    return connectionGeneration;
  },
};
let params: NativeConversationParams = { sessionId: 'saved-session', executionNodeId: 'local' };
const state = () => ({
  workspaceAccess: access,
  status,
  client: hasClient ? client : null,
  activeProfileId: 'saved-profile',
  gatewayUrl: 'ws://127.0.0.1:7917',
  principalId: null,
  authorityEpoch: 0,
});
const session: NativeSessionReadResult['session'] = {
  id: 'saved-session',
  executionNodeId: 'local',
  ownerPrincipalId: 'saved-owner',
  profileId: 'profile',
  accountContextId: 'account',
  generation: 'generation',
  nativeSessionId: 'native',
  hostPid: 1,
  runner: 'codex',
  cwd: '/workspace',
  executable: '',
  version: 'sample',
  mode: 'default',
  accountMode: 'native',
  state: 'closed',
  capabilities: {
    modes: ['default'],
    streaming: true,
    tools: true,
    approvals: true,
    questions: true,
    interrupt: true,
    resume: true,
  },
};
const history: ResourceQueryState<NativeSessionReadResult> = {
  status: 'stale',
  observedAt: 1234,
  data: {
    session,
    cursor: 660,
    hasMore: false,
    commands: [],
    pendingRequests: [],
    events: [
      {
        sequence: 660,
        type: 'text.delta',
        commandId: 'saved-command',
        generation: 'generation',
        sessionId: session.id,
        at: '2026-10-24T00:00:00Z',
        text: 'saved complete answer',
      },
    ],
  },
};
const loading = { status: 'loading' };
mock.module('@react-native-async-storage/async-storage', {
  defaultExport: { getItem: async () => null, setItem: async () => undefined },
});
mock.module('expo-router', {
  namedExports: {
    useLocalSearchParams: () => params,
    useIsFocused: () => true,
    Redirect: ({ href }: { href: string }) => React.createElement('span', null, `redirect:${href}`),
  },
});
mock.module('../store/connection', {
  namedExports: {
    useConnectionStore: Object.assign(
      (select: (value: ReturnType<typeof state>) => unknown) => select(state()),
      { getState: state },
    ),
  },
});
mock.module('./resource-cache', {
  namedExports: {
    getResourceWorkspaceAccess: () => remembered,
    subscribeResourceCache: () => () => undefined,
    getResourceNativeOwnerId: () => (remembered === 'none' ? undefined : 'saved-owner'),
    getResourceCache: () => undefined,
  },
});
mock.module('../hooks/useResourceQuery', {
  namedExports: {
    useResourceQuery: (query?: ResourceQuery<unknown>) =>
      query?.method === 'native.session.read' ? history : loading,
  },
});
mock.module('../farmslot/run-collections-proof', {
  namedExports: {
    observeNativeConversation: () => () => undefined,
  },
});
mock.module('../features/native-conversation/use-native-session-setup', {
  namedExports: {
    useNativeSessionSetup: () => ({ viewModel: {}, actions: {} }),
  },
});
mock.module('../features/native-conversation/use-native-profile-selection', {
  namedExports: {
    useNativeProfileSelection: () => ({ viewModel: { ready: false }, actions: {} }),
  },
});
let readConversation: (params: NativeConversationParams) => {
  viewModel: {
    session?: NativeSessionReadResult['session'];
    entries: Array<{ text?: string }>;
    writable: boolean;
    canSend: boolean;
    canStop: boolean;
    historyObservation: ResourceQueryState<NativeSessionReadResult>;
  };
};
mock.module('../features/native-conversation/NativeConversation', {
  namedExports: {
    NativeConversation: ({ params: selection }: { params: NativeConversationParams }) => {
      const vm = readConversation(selection).viewModel;
      return React.createElement(
        'span',
        null,
        JSON.stringify({
          sessionId: vm.session?.id,
          messages: vm.entries.map((entry) => entry.text),
          observedAt: vm.historyObservation.observedAt,
          writable: vm.writable,
          canSend: vm.canSend,
          canStop: vm.canStop,
        }),
      );
    },
  },
});
let harness: { render: () => string } | undefined;
let renderedConversationKey: string | null = null;
async function load() {
  if (harness) return harness.render;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const controller =
    await import('../features/native-conversation/use-native-conversation-controller');
  readConversation = controller.useNativeConversationController;
  const route = await import('../app/native');
  function ObserveRouteIdentity() {
    const element = route.default();
    renderedConversationKey = element.key;
    return element;
  }
  harness = { render: () => renderToStaticMarkup(React.createElement(ObserveRouteIdentity)) };
  return harness.render;
}

test('cold offline native route renders scoped saved history with stale controls', async () => {
  const render = await load();
  for (const retainedAccess of ['native', 'farm'] as const) {
    remembered = retainedAccess;
    access = 'none';
    status = 'disconnected';
    params = { sessionId: 'saved-session', executionNodeId: 'local' };
    const html = render();
    assert.doesNotMatch(html, /redirect:/);
    assert.match(html, /saved-session/);
    assert.match(html, /saved complete answer/);
    assert.match(html, /1234/);
    for (const control of ['writable', 'canSend', 'canStop'])
      assert.match(html, new RegExp(`&quot;${control}&quot;:false`));
  }
});

test('missing retained scope and a current live revocation still reject history', async () => {
  const render = await load();
  params = { sessionId: 'saved-session', executionNodeId: 'local' };
  access = 'none';
  remembered = 'none';
  status = 'disconnected';
  assert.match(render(), /redirect:\/\(tabs\)\/settings/);
  remembered = 'farm';
  status = 'connected';
  assert.match(render(), /redirect:\/\(tabs\)\/settings/);
});

test('retained native-only scope cannot admit worker authority route params', async () => {
  const render = await load();
  access = 'none';
  remembered = 'native';
  status = 'disconnected';
  for (const field of ['runId', 'contextId', 'leaseId', 'generation'] as const) {
    params = { sessionId: 'saved-session', [field]: 'worker-authority' };
    assert.match(render(), /redirect:\/native/);
  }
});

test('offline reconnect attempts preserve the selected conversation identity', async () => {
  const render = await load();
  access = 'none';
  remembered = 'native';
  hasClient = true;
  status = 'disconnected';
  connectionGeneration = 3;
  params = { sessionId: 'saved-session', executionNodeId: 'local' };
  render();
  const offlineKey = renderedConversationKey;
  assert(offlineKey);
  for (const next of ['connecting', 'disconnected', 'connecting', 'disconnected']) {
    status = next;
    connectionGeneration++;
    render();
    assert.equal(
      renderedConversationKey,
      offlineKey,
      'Offline retries must not remount the screen',
    );
  }
  access = 'native';
  status = 'connected';
  render();
  const currentKey = renderedConversationKey;
  assert.notEqual(currentKey, offlineKey);
  connectionGeneration++;
  render();
  assert.notEqual(
    renderedConversationKey,
    currentKey,
    'A new current connection still resets controls',
  );
  hasClient = false;
});
