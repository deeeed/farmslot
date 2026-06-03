import { html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type { ChatMessage, ChatToolTraceEntry } from '@farmslot/protocol';

import '../components/chat/chat-panel.js';
import '../components/chat/chat-message.js';
import '../components/chat/chat-action-card.js';

import { colors, fonts, spacing } from '../styles/theme-tokens.js';

const traceTiming = (offsetMs: number, durationMs: number) => {
  const startedAt = new Date(Date.now() - offsetMs).toISOString();
  const completedAt = new Date(Date.now() - offsetMs + durationMs).toISOString();
  return { startedAt, completedAt, durationMs };
};

const toolTrace = (
  entry: Omit<ChatToolTraceEntry, 'startedAt' | 'completedAt' | 'durationMs'> & {
    offsetMs: number;
    durationMs: number;
  },
): ChatToolTraceEntry => {
  const { offsetMs, durationMs, ...rest } = entry;
  return {
    ...rest,
    ...traceTiming(offsetMs, durationMs),
  };
};

const MOCK_MESSAGES: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    content: 'What slots are free right now?',
    timestamp: new Date(Date.now() - 120000).toISOString(),
  },
  {
    id: 'm2',
    role: 'assistant',
    content: `Based on the current fleet state:\n\n**Free slots:**\n| Slot | Lifecycle | Branch |\n|---|---|---|\n| runner-mobile-1 | ready | main |\n| runner-mobile-2 | released | main |\n\nrunner-mobile-3 is currently working on PROJ-2483.`,
    timestamp: new Date(Date.now() - 110000).toISOString(),
    nextSteps: [
      {
        id: 'inspect-active-runs',
        label: 'Inspect active runs',
        kind: 'read',
        safety: 'read-only',
        params: {
          prompt: 'Use operator_snapshot and list_active_runs to summarize currently active runs.',
        },
      },
      {
        id: 'explain-queue',
        label: 'Explain queue status',
        kind: 'prompt',
        safety: 'read-only',
        params: { prompt: 'Explain whether any queued work is blocked and cite gateway evidence.' },
      },
    ],
    toolTrace: [
      toolTrace({
        toolName: 'fleet.status',
        status: 'ok',
        round: 1,
        callId: 'trace-fleet-status-1',
        resultSummary: 'Loaded 8 slots across 3 machines; 2 slots are currently available.',
        outputSize: 1240,
        truncated: false,
        summaryKind: 'json-shape',
        offsetMs: 114000,
        durationMs: 138,
      }),
      toolTrace({
        toolName: 'memory.search',
        status: 'ok',
        round: 1,
        callId: 'trace-memory-search-1',
        resultSummary:
          'Checked recent fleet notes; redacted sentinel marker SENTINEL_SECRET_[redacted] stayed out of display payloads.',
        outputSize: 482,
        truncated: false,
        summaryKind: 'text',
        offsetMs: 113700,
        durationMs: 82,
      }),
    ],
  },
  {
    id: 'm3',
    role: 'user',
    content: 'Can you dispatch PROJ-2490 to runner-mobile-1?',
    timestamp: new Date(Date.now() - 60000).toISOString(),
  },
  {
    id: 'm4',
    role: 'assistant',
    content: `Sure. I'll set up a dispatch for PROJ-2490 on runner-mobile-1 as a fix-bug run.`,
    timestamp: new Date(Date.now() - 55000).toISOString(),
    nextSteps: [
      {
        id: 'review-dispatch-inputs',
        label: 'Review dispatch inputs',
        kind: 'prompt',
        safety: 'read-only',
        params: { prompt: 'Review the proposed dispatch inputs and identify any missing details.' },
      },
      {
        id: 'inspect-slot-readiness',
        label: 'Inspect slot readiness',
        kind: 'read',
        safety: 'read-only',
        params: { prompt: 'Inspect the target slot readiness and summarize any dispatch risks.' },
      },
    ],
    toolTrace: [
      toolTrace({
        toolName: 'run.preview',
        status: 'ok',
        round: 2,
        callId: 'trace-run-preview-1',
        resultSummary:
          'Validated ticket, project, flow type, and target slot before offering the dispatch action.',
        outputSize: 916,
        truncated: false,
        summaryKind: 'run-bundle',
        offsetMs: 58500,
        durationMs: 204,
      }),
      toolTrace({
        toolName: 'workspace.inspect',
        status: 'ok',
        round: 2,
        callId: 'trace-workspace-inspect-1',
        resultSummary:
          'Suppressed file snippet marker SENTINEL_FILE_SNIPPET_[redacted] while preserving the evidence count.',
        outputSize: 2048,
        truncated: true,
        summaryKind: 'file-read',
        offsetMs: 58100,
        durationMs: 311,
      }),
    ],
    suggestedActions: [
      {
        type: 'run.create',
        label: 'Dispatch PROJ-2490 to runner-mobile-1',
        params: {
          ticketOrPr: 'PROJ-2490',
          flowType: 'fix-bug',
          project: 'example-mobile',
          slotId: 'runner-mobile-1',
        },
      },
    ],
  },
];

const MOCK_MEMORY_ACTION: ChatMessage = {
  id: 'm5',
  role: 'assistant',
  content: 'I noticed runner-local runs the most jobs. Want me to save this to memory?',
  timestamp: new Date().toISOString(),
  suggestedActions: [
    {
      type: 'memory.update',
      label: 'Save fleet note to memory',
      params: {
        content:
          '# Farmslot Co-Pilot Memory\n\n## Fleet Notes\nrunner-local is the primary workhorse — 4 slots, runs most jobs.\n\n## User Preferences\n',
      },
    },
  ],
};

@customElement('chat-dev-harness')
export class ChatDevHarness extends LitElement {
  @state() private showPanel = true;
  @state() private streamingDemo = false;
  @state() private streamText = '';

  protected override createRenderRoot() {
    return this;
  }

  private startStreamDemo() {
    const words =
      'Checking fleet state now... runner-mobile-1 is ready on main, runner-mobile-2 is working on PROJ-2489.'.split(
        ' ',
      );
    let i = 0;
    this.streamText = '';
    this.streamingDemo = true;
    const iv = setInterval(() => {
      if (i >= words.length) {
        clearInterval(iv);
        this.streamingDemo = false;
        return;
      }
      this.streamText += (i > 0 ? ' ' : '') + words[i++];
    }, 120);
  }

  render() {
    return html`
      <style>
        chat-dev-harness {
          display: block;
          padding: ${spacing.xl};
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeSm};
          color: ${colors.textPrimary};
          background: ${colors.bgBase};
          min-height: 100vh;
        }
        chat-dev-harness h2 {
          color: ${colors.textAccent};
          margin: ${spacing.xxl} 0 ${spacing.lg};
          font-size: ${fonts.sizeMd};
        }
        chat-dev-harness .demo-section {
          background: ${colors.bgSurface};
          border: 1px solid ${colors.bgCard};
          border-radius: 6px;
          padding: ${spacing.xl};
          margin-bottom: ${spacing.xl};
          max-width: 640px;
        }
        chat-dev-harness .btn {
          background: ${colors.accent};
          color: #fff;
          border: none;
          border-radius: 4px;
          padding: 4px 12px;
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeSm};
          cursor: pointer;
          margin-right: ${spacing.md};
        }
      </style>

      <h2>Chat Components Dev Harness</h2>

      <div class="demo-section">
        <h3 style="margin:0 0 12px;color:${colors.textSecondary}">Individual Messages</h3>
        <chat-message .message=${MOCK_MESSAGES[0]}></chat-message>
        <chat-message .message=${MOCK_MESSAGES[1]}></chat-message>
      </div>

      <div class="demo-section">
        <h3 style="margin:0 0 12px;color:${colors.textSecondary}">Streaming State</h3>
        <button class="btn" @click=${this.startStreamDemo}>Start Stream Demo</button>
        ${this.streamingDemo
          ? html`
              <div
                style="margin-top:12px;background:${colors.bgCard};padding:8px 12px;border-radius:6px;font-size:${fonts.sizeSm}"
              >
                ${this.streamText}<span style="animation:blink 1s infinite;display:inline-block"
                  >▌</span
                >
              </div>
              <style>
                @keyframes blink {
                  0%,
                  100% {
                    opacity: 1;
                  }
                  50% {
                    opacity: 0;
                  }
                }
              </style>
            `
          : ''}
      </div>

      <div class="demo-section">
        <h3 style="margin:0 0 12px;color:${colors.textSecondary}">Action Card — run.create</h3>
        <chat-action-card .action=${MOCK_MESSAGES[3].suggestedActions![0]}></chat-action-card>
      </div>

      <div class="demo-section">
        <h3 style="margin:0 0 12px;color:${colors.textSecondary}">Action Card — memory.update</h3>
        <chat-action-card .action=${MOCK_MEMORY_ACTION.suggestedActions![0]}></chat-action-card>
      </div>

      <div class="demo-section">
        <h3 style="margin:0 0 12px;color:${colors.textSecondary}">Full Conversation</h3>
        ${MOCK_MESSAGES.map((m) => html`<chat-message .message=${m}></chat-message>`)}
        <chat-message .message=${MOCK_MEMORY_ACTION}></chat-message>
      </div>

      <div style="height:460px"></div>
      <chat-panel
        .open=${this.showPanel}
        @close=${() => {
          this.showPanel = false;
        }}
      ></chat-panel>
      <div style="position:fixed;bottom:8px;right:8px;z-index:2000">
        <button
          class="btn"
          @click=${() => {
            this.showPanel = !this.showPanel;
          }}
        >
          ${this.showPanel ? 'Hide Panel' : 'Show Panel'}
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-dev-harness': ChatDevHarness;
  }
}
