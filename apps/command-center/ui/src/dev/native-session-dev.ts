import { html, LitElement } from 'lit';
import { customElement } from 'lit/decorators.js';

import { Methods, type NativeSessionInfo, type NativeSessionReadResult } from '@farmslot/protocol';

import '../components/chat/native-session-view.js';

import type { NativeSessionApi } from '../components/chat/native-workspace.js';
import { getHashParam } from '../utils/url-state.js';

import { createNativeReplayFixture } from './native-session-replay-dev.js';

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
const fixtureApi: NativeSessionApi = {
  async request<T>(method: string, params?: unknown): Promise<T> {
    const p = params as { after?: number; path?: string };
    let result: unknown;
    switch (method) {
      case Methods.NATIVE_SESSION_CATALOG:
        result = {
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
        break;
      case Methods.NATIVE_SESSION_LIST:
        result = { sessions: [session] };
        break;
      case Methods.NATIVE_SESSION_CREATE:
        result = { session };
        break;
      case Methods.NATIVE_SESSION_READ:
        result = {
          ...page,
          events: page.events.filter((event) => event.sequence > (p.after ?? 0)),
        };
        break;
      case Methods.NATIVE_SESSION_WORKSPACE_CHANGES:
        result = { files: [{ path: 'greeting.ts', status: ' M' }] };
        break;
      case Methods.NATIVE_SESSION_WORKSPACE_LIST:
        result = {
          entries: [{ path: 'greeting.ts', name: 'greeting.ts', directory: false }],
          truncated: false,
        };
        break;
      case Methods.NATIVE_SESSION_WORKSPACE_READ:
        result = { path: 'greeting.ts', content: 'export const greeting = "Hello Farmslot";\n' };
        break;
      case Methods.NATIVE_SESSION_WORKSPACE_DIFF:
        result = {
          path: 'greeting.ts',
          diff: 'diff --git a/greeting.ts b/greeting.ts\n--- a/greeting.ts\n+++ b/greeting.ts\n@@ -1 +1 @@\n-export const greeting = "Hello";\n+export const greeting = "Hello Farmslot";\n',
        };
        break;
      default:
        throw new Error('This preview is read-only. Use a real session to send or answer.');
    }
    return result as T;
  },
};

@customElement('native-session-dev')
export class NativeSessionDev extends LitElement {
  private previewApi = (() => {
    const replay = getHashParam('replay');
    return replay && ['matching', 'foreign-command', 'foreign-generation'].includes(replay)
      ? createNativeReplayFixture(session, replay)
      : fixtureApi;
  })();

  render() {
    return html`<style>
        :host {
          display: flex;
          height: 80vh;
          flex-direction: column;
        }</style
      ><native-session-view .api=${this.previewApi} .fixture=${true}></native-session-view>`;
  }
}
