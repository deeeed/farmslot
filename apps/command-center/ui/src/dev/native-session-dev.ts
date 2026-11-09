import { html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import { Methods, type NativeSessionInfo, type NativeSessionReadResult } from '@farmslot/protocol';

import '../components/chat/native-session-view.js';

import type { NativeSessionFixture } from '../components/chat/native-session-view.js';
import type {
  NativeSessionApi,
  NativeSessionCommand,
} from '../components/chat/native-workspace.js';
import { getHashParam } from '../utils/url-state.js';

import { createNativeReplayFixture } from './native-session-replay-dev.js';
import {
  createNativeStreamFixture,
  type NativeStreamCost,
  type NativeStreamFixture,
} from './native-session-stream-dev.js';

const session: NativeSessionInfo = {
  id: 'fixture-session',
  generation: 'fixture-generation',
  hostPid: 0,
  runner: 'sample',
  nativeSessionId: 'fixture-conversation',
  ownerPrincipalId: 'fixture',
  executionNodeId: 'local',
  accountContextId: 'local-owner',
  cwd: '/workspace/project',
  executable: '',
  version: 'fixture',
  mode: 'default',
  accountMode: 'native',
  state: 'waiting',
  model: 'sample-model',
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
const approval: NativeSessionReadResult['events'][number] = {
  sessionId: session.id,
  generation: session.generation,
  sequence: 4,
  at: '2026-09-12T08:00:00Z',
  type: 'approval.requested',
  nativeId: 'request',
  request: {
    id: 'fixture-generation:approval',
    title: 'Update greeting.ts',
    detail:
      'Write the greeting requested in this workspace.\nNo files outside the workspace will change.',
  },
};
const page: NativeSessionReadResult = {
  session,
  cursor: 5,
  hasMore: false,
  commands: [],
  pendingRequests: [approval],
  events: [
    {
      sessionId: session.id,
      generation: session.generation,
      sequence: 1,
      at: '2026-09-12T08:00:00Z',
      type: 'command.submitted',
      commandId: 'command',
      text: 'Update the greeting and show the diff.',
    },
    {
      sessionId: session.id,
      generation: session.generation,
      sequence: 2,
      at: '2026-09-12T08:00:01Z',
      type: 'text.delta',
      commandId: 'command',
      text: 'I found the greeting. The proposed change is below.',
    },
    {
      sessionId: session.id,
      generation: session.generation,
      sequence: 3,
      at: '2026-09-12T08:00:02Z',
      type: 'tool.completed',
      tool: { name: 'read_file', output: 'export const greeting = "Hello";', status: 'completed' },
    },
    approval,
    {
      sessionId: session.id,
      generation: session.generation,
      sequence: 5,
      at: '2026-09-12T08:00:03Z',
      type: 'error',
      data: { code: 'PREVIEW_ERROR', detail: 'Example error without optional display text' },
    },
  ],
};

/** Setup-time fixture client, never a production gateway or mid-flow state injection. */
const fixtureApi: NativeSessionApi & NativeSessionFixture = {
  async catalog() {
    return {
      runners: [
        {
          runner: 'sample',
          models: ['sample-model'],
          defaultModel: 'sample-model',
          modes: ['default'],
        },
      ],
      contexts: [{ cwd: session.cwd, label: 'Sample project' }],
    };
  },
  async list() {
    return { sessions: [session] };
  },
  async read({ after = 0 }) {
    return { ...page, events: page.events.filter((event) => event.sequence > after) };
  },
  async request<T>(method: NativeSessionCommand): Promise<T> {
    if (method !== Methods.NATIVE_SESSION_CREATE)
      throw new Error('This preview is read-only. Use a real session to send or answer.');
    return { session } as T;
  },
};

@customElement('native-session-dev')
export class NativeSessionDev extends LitElement {
  /** `#dev/native-session?stream=1`: a 300+ row conversation that streams through the cache. */
  private streamApi?: NativeStreamFixture =
    getHashParam('stream') === '1' ? createNativeStreamFixture(session) : undefined;
  private previewApi = (() => {
    if (this.streamApi) return this.streamApi;
    const replay = getHashParam('replay');
    if (replay && ['matching', 'foreign-command', 'foreign-generation'].includes(replay))
      return createNativeReplayFixture(session, replay);
    // Each preview seeds its own selection, so one opened earlier does not carry over.
    localStorage.setItem('farmslot-native:fixture:selected', session.id);
    return fixtureApi;
  })();
  @state() private streamCost?: NativeStreamCost | string;

  private async stream() {
    const api = this.streamApi;
    if (!api) return;
    this.streamCost = 'Streaming…';
    try {
      this.streamCost = await api.stream(200, () =>
        this.renderRoot
          .querySelector('native-session-view')
          ?.shadowRoot?.querySelector('.timeline'),
      );
    } catch (error) {
      // The preview shows the failure where the result would be; the probe reads it from there.
      this.streamCost = `Stream failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  render() {
    return html`<style>
        :host {
          display: flex;
          height: 80vh;
          flex-direction: column;
        }</style
      >${this.streamApi
        ? html`<button data-testid="native-stream-start" @click=${() => void this.stream()}>
              Stream 200 deltas
            </button>
            <pre data-testid="native-stream-cost">
${typeof this.streamCost === 'string'
                ? this.streamCost
                : this.streamCost
                  ? JSON.stringify(this.streamCost)
                  : ''}</pre
            >`
        : ''}<native-session-view
        .api=${this.previewApi}
        .fixture=${this.previewApi}
      ></native-session-view>`;
  }
}
