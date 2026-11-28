import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import React, { type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { NativeProfileInfo, NativeSessionInfo } from '@farmslot/protocol';

import type { NativeConversationScreen } from './NativeConversationScreen';

interface PrimitiveProps {
  children?: ReactNode;
  testID?: string;
}

function primitive(tag: string) {
  return ({ children, testID }: PrimitiveProps) =>
    React.createElement(tag, { 'data-testid': testID }, children);
}

mock.module('react-native', {
  namedExports: {
    KeyboardAvoidingView: primitive('main'),
    Modal: () => null,
    Platform: { OS: 'ios' },
    Pressable: primitive('button'),
    ScrollView: primitive('div'),
    StyleSheet: { create: (styles: unknown) => styles },
    Text: primitive('span'),
    TextInput: primitive('textarea'),
    View: primitive('div'),
  },
});
mock.module('react-native-safe-area-context', {
  namedExports: { useSafeAreaInsets: () => ({ bottom: 0 }) },
});
mock.module('@shopify/flash-list', {
  namedExports: {
    FlashList: ({
      testID,
      ListHeaderComponent,
    }: PrimitiveProps & { ListHeaderComponent?: ReactNode }) =>
      React.createElement('section', { 'data-testid': testID }, ListHeaderComponent),
  },
});
mock.module('../../components/ResourceReadStatus', {
  namedExports: { ResourceReadStatus: () => null },
});
mock.module('../../components/view-state', {
  namedExports: { useViewChoice: () => [{}, () => {}] },
});
mock.module('./components/NativeSessionSetup', {
  namedExports: { NativeSessionSetup: () => null },
});
mock.module('./components/NativeTimelineCard', {
  namedExports: { NativePendingMessageCard: () => null, NativeTimelineCard: () => null },
});

type ScreenProps = ComponentProps<typeof NativeConversationScreen>;

const noAction = () => undefined;
const noAsyncAction = async () => undefined;
const profile: NativeProfileInfo = {
  id: 'personal',
  runner: 'codex',
  directory: '/config/personal',
  accountContextId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  state: 'active',
};
const profileSelection: ScreenProps['viewModel']['resume']['profiles'] = {
  visible: false,
  loading: false,
  readIssue: undefined,
  error: '',
  reason: undefined,
  status: undefined,
  ready: false,
  selected: undefined,
  profiles: [],
};
const profileActions: ScreenProps['actions']['resume']['profiles'] = {
  choose: noAction,
  refresh: noAction,
  validate: noAsyncAction,
};

async function renderConversation(state: 'closed' | 'idle') {
  const { NativeConversationScreen } = await import('./NativeConversationScreen');
  const closed = state === 'closed';
  const session: NativeSessionInfo = {
    id: 'conversation',
    generation: 'generation',
    hostPid: 1,
    processStopped: closed,
    runner: profile.runner,
    nativeSessionId: 'native-conversation',
    ownerPrincipalId: 'owner',
    executionNodeId: 'local',
    accountContextId: profile.accountContextId,
    profileId: profile.id,
    cwd: '/workspace',
    executable: '/runner/codex',
    version: 'current',
    mode: 'default',
    accountMode: 'native',
    state,
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
  const viewModel: ScreenProps['viewModel'] = {
    sessions: [],
    unavailable: [],
    creation: {
      catalog: undefined,
      choices: [],
      contextKey: '',
      customCwd: '',
      custom: false,
      executionPicker: undefined,
      contextIndex: -1,
      contextUnavailable: false,
      runner: undefined,
      model: '',
      mode: 'default',
      loading: false,
      profiles: profileSelection,
      creating: false,
      controlsDisabled: true,
      catalogError: undefined,
      error: undefined,
      canCreate: false,
    },
    session,
    work: undefined,
    workspace: undefined,
    turnDiffs: undefined,
    connected: true,
    ready: true,
    writable: !closed,
    entries: [],
    rows: [],
    requests: [],
    responses: [],
    draft: '',
    pending: undefined,
    pendingText: undefined,
    receipt: undefined,
    canRetry: false,
    canEdit: false,
    error: '',
    busy: false,
    canSend: false,
    canSteer: false,
    implementKey: undefined,
    implementing: false,
    steerable: false,
    sendLabel: 'Send',
    canStop: false,
    workerLabel: undefined,
    historyObservation: { status: 'ready' },
    history: undefined,
    historyNotice: '',
    inventoryObservation: { status: 'ready' },
    runObservation: undefined,
    resume: {
      available: closed,
      busy: false,
      ready: closed,
      implementable: false,
      implementReady: false,
      error: '',
      profiles: {
        ...profileSelection,
        visible: closed,
        ready: closed,
        selected: {
          executionNodeId: 'local',
          runner: profile.runner,
          profileId: profile.id,
          accountContextId: profile.accountContextId,
        },
        profiles: [profile],
      },
    },
  };
  const actions: ScreenProps['actions'] = {
    creation: {
      profiles: profileActions,
      selectChoice: noAction,
      selectCustomCwd: noAction,
      selectEffort: noAction,
      selectContext: noAction,
      selectRunner: noAction,
      selectModel: noAction,
      selectMode: noAction,
      refresh: noAction,
      create: noAsyncAction,
    },
    resume: {
      profiles: profileActions,
      resume: noAsyncAction,
      implement: noAsyncAction,
    },
    readSaved: noAsyncAction,
    dismissSaved: noAction,
    refresh: noAsyncAction,
    retryRun: noAsyncAction,
    send: noAsyncAction,
    retry: noAsyncAction,
    edit: noAsyncAction,
    respond: noAsyncAction,
    reportFollow: noAction,
    setDraft: noAction,
    saveDraft: noAsyncAction,
    stop: noAsyncAction,
  };
  return renderToStaticMarkup(
    React.createElement(NativeConversationScreen, {
      viewModel,
      actions,
      selected: true,
      onSelect: () => {},
    }),
  );
}

test('a closed resumable conversation renders Resume and its locked profile below the transcript', async () => {
  const markup = await renderConversation('closed');
  const [transcript, afterTranscript] = markup.split('</section>');
  assert.match(transcript, /companion-native-transcript/);
  assert.match(transcript, /companion-native-session-profile[^>]*>Configuration: personal/);
  assert.doesNotMatch(transcript, /companion-native-resume/);
  assert.ok(afterTranscript);
  const footer = afterTranscript.split('data-testid="companion-native-resume-footer"')[1];
  assert.ok(footer);
  assert.match(footer, /companion-native-read-only/);
  assert.match(footer, /data-testid="companion-native-resume"><span>Resume conversation/);
  assert.match(footer, /Saved configuration: personal/);
  assert.doesNotMatch(afterTranscript, /companion-native-profile-default|companion-native-draft/);
});

test('an active conversation keeps the composer and has no Resume footer', async () => {
  const markup = await renderConversation('idle');
  assert.match(markup, /companion-native-transcript/);
  assert.match(markup, /companion-native-draft/);
  assert.doesNotMatch(markup, /companion-native-resume|companion-native-read-only/);
});
