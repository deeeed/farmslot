import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type {
  ChatMessage,
  ChatSessionContextResult,
  ChatSessionSummary,
  CopilotObserverNotificationPayload,
  CopilotRuntimeSession,
} from '@farmslot/protocol';

import { safeLsGet } from '../../utils/storage.js';

import {
  ACTIVE_SESSION_KEY,
  DEFAULT_DRAWER_HEIGHT,
  MIN_DRAWER_HEIGHT,
  normalizeStoredSessionId,
} from './chat-panel-model.js';

export abstract class ChatPanelState extends LitElement {
  @property({ type: Boolean }) open = false;

  @state() protected messages: ChatMessage[] = [];
  @state() protected streamingText = '';
  @state() protected streamingStatus = '';
  @state() protected streamingError = '';
  @state() protected sending = false;
  @state() protected inputText = '';
  @state() protected memorySavedToast: string | null = null;
  @state() protected sessionCost = 0;
  @state() protected usageOpen = false;
  @state() protected usageLoading = false;
  @state() protected usageContext: ChatSessionContextResult | null = null;
  @state() protected usageError: string | null = null;
  @state() protected fullscreen = false;
  @state() protected drawerHeight = DEFAULT_DRAWER_HEIGHT;
  @state() protected activeSessionIdValue = normalizeStoredSessionId(safeLsGet(ACTIVE_SESSION_KEY));
  @state() protected sessionSummaries: ChatSessionSummary[] = [];
  @state() protected observerNotifications: CopilotObserverNotificationPayload[] = [];
  @state() protected historyOpen = false;
  @state() protected pinningActive = false;
  @state() protected runtime: CopilotRuntimeSession | null = null;
  @state() protected runtimeLoading = false;
  @state() protected runtimeError = '';
  @state() protected runtimeNotice = '';
  @state() protected runtimeRunner = '';
  @state() protected runtimeModel = '';
  @state() protected runtimeAutostart = false;
  @state() protected runtimeWorkerRefJson = '';
  @state() protected dangerousConfirmationOpen = false;
  @state() protected dangerousTypedPhrase = '';

  protected unsubResponse?: () => void;
  protected unsubMemory?: () => void;
  protected unsubObserver?: () => void;
  protected unsubConnection?: () => void;
  protected unsubRuntime?: () => void;
  protected toastTimer?: ReturnType<typeof setTimeout>;
  protected runtimeWorkerLookup?: Promise<void>;
  protected runtimeWorkerLookupTarget = '';
  protected runtimeWorkerRetry?: ReturnType<typeof setTimeout>;
  protected runtimeWorkerRetryMs = 1000;
  protected runtimeWorkerSession = '';
  protected resizing = false;
  protected resizeStartY = 0;
  protected resizeStartHeight = DEFAULT_DRAWER_HEIGHT;
  protected readonly minDrawerHeight = MIN_DRAWER_HEIGHT;
}
