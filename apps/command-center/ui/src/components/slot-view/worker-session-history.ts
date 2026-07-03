import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  ChatMessage,
  WorkerSessionHistoryDeltaPayload,
  WorkerSessionHistoryMessage,
  WorkerSessionHistorySnapshot,
  WorkerSessionHistorySubscribeResult,
} from '@farmslot/protocol';
import { Events, Methods } from '@farmslot/protocol';

import '../chat/chat-message.js';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

@customElement('worker-session-history')
export class WorkerSessionHistoryElement extends LitElement {
  @property() slotId = '';
  @property() runId = '';
  @property() role = '';
  @property() contextId = '';

  @state() private snapshot: WorkerSessionHistorySnapshot | null = null;
  @state() private loading = false;
  @state() private error = '';

  private unsubscribeEvent?: () => void;
  private subscriptionKey = '';
  private subscriptionTarget: ReturnType<WorkerSessionHistoryElement['targetParams']> | null = null;

  protected override createRenderRoot() {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.resubscribe();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    void this.teardownSubscription();
  }

  override updated(changed: Map<string, unknown>): void {
    if (
      changed.has('slotId') ||
      changed.has('runId') ||
      changed.has('role') ||
      changed.has('contextId')
    ) {
      void this.resubscribe();
    }
  }

  private targetParams() {
    return {
      slotId: this.slotId,
      ...(this.runId ? { runId: this.runId } : {}),
      ...(this.role ? { role: this.role } : {}),
      ...(this.contextId ? { contextId: this.contextId } : {}),
    };
  }

  private makeKey(): string {
    const params = this.targetParams();
    return [params.slotId, params.runId ?? '', params.role ?? '', params.contextId ?? ''].join(':');
  }

  private async teardownSubscription(): Promise<void> {
    this.unsubscribeEvent?.();
    this.unsubscribeEvent = undefined;
    const target = this.subscriptionTarget;
    if (!this.subscriptionKey || !target?.slotId) return;
    try {
      await gateway.request(Methods.WORKER_SESSION_HISTORY_UNSUBSCRIBE, target, 5_000);
    } catch (err) {
      console.warn(`[worker-history] unsubscribe failed: ${(err as Error).message}`);
    }
    this.subscriptionKey = '';
    this.subscriptionTarget = null;
  }

  private async resubscribe(): Promise<void> {
    if (!this.isConnected || !this.slotId) return;
    const nextKey = this.makeKey();
    if (nextKey === this.subscriptionKey) return;
    await this.teardownSubscription();
    this.loading = true;
    this.error = '';
    this.snapshot = null;
    this.subscriptionKey = nextKey;
    this.subscriptionTarget = this.targetParams();
    this.unsubscribeEvent = gateway.subscribe<WorkerSessionHistoryDeltaPayload>(
      Events.WORKER_SESSION_HISTORY_DELTA,
      (payload) => this.applyDelta(payload),
    );
    try {
      const result = await gateway.request<WorkerSessionHistorySubscribeResult>(
        Methods.WORKER_SESSION_HISTORY_SUBSCRIBE,
        { ...this.targetParams(), limit: 300 },
        20_000,
      );
      if (!this.isConnected || this.makeKey() !== nextKey) return;
      this.snapshot = result.snapshot;
    } catch (err) {
      if (!this.isConnected || this.makeKey() !== nextKey) return;
      this.error = (err as Error).message;
    } finally {
      if (this.makeKey() === nextKey) this.loading = false;
    }
  }

  private applyDelta(payload: WorkerSessionHistoryDeltaPayload): void {
    if (!this.snapshot) return;
    if (payload.slotId !== this.slotId) return;
    if ((payload.runId ?? '') !== (this.snapshot.runId ?? '')) return;
    if ((payload.role ?? '') !== (this.snapshot.role ?? '')) return;
    if ((payload.contextId ?? '') !== (this.snapshot.contextId ?? '')) return;

    const messages = payload.reset
      ? payload.messages
      : [...this.snapshot.messages, ...payload.messages].slice(-300);
    this.snapshot = {
      ...this.snapshot,
      runner: payload.runner,
      runnerSessionPath: payload.runnerSessionPath ?? this.snapshot.runnerSessionPath,
      source: payload.source,
      messages,
      cursor: payload.cursor,
      degradedReason: payload.degradedReason,
      generatedAt: payload.generatedAt,
    };
  }

  private toChatMessage(message: WorkerSessionHistoryMessage): ChatMessage {
    const at = message.at ?? this.snapshot?.generatedAt ?? new Date().toISOString();
    return {
      id: message.id,
      role: message.role,
      content: message.text || '',
      timestamp: at,
      toolTrace: message.tools?.map((tool, index) => ({
        callId: tool.id ?? `${message.id}:tool:${index}`,
        toolName: tool.name,
        round: index + 1,
        status: 'ok',
        startedAt: at,
        completedAt: at,
        durationMs: 0,
        resultSummary: 'Runner transcript recorded this tool call.',
        outputSize: 0,
        truncated: false,
        summaryKind: 'text',
      })),
    };
  }

  private renderBody() {
    if (this.loading) return html`<div class="wsh-empty">Loading transcript...</div>`;
    if (this.error) return html`<div class="wsh-empty error">${this.error}</div>`;
    if (!this.snapshot) return html`<div class="wsh-empty">No transcript snapshot.</div>`;
    if (this.snapshot.source !== 'transcript') {
      return html`
        <div class="wsh-empty">
          ${this.snapshot.degradedReason ?? 'Worker transcript is unavailable for this runner.'}
        </div>
      `;
    }
    if (this.snapshot.messages.length === 0) {
      return html`<div class="wsh-empty">No user or assistant turns found.</div>`;
    }
    return html`
      <div class="wsh-messages">
        ${this.snapshot.messages.map(
          (message) => html`<chat-message .message=${this.toChatMessage(message)}></chat-message>`,
        )}
      </div>
    `;
  }

  override render() {
    const source = this.snapshot?.source ?? 'unavailable';
    const runner = this.snapshot?.runner ?? 'runner';
    return html`
      <style>
        worker-session-history {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          background: ${colors.bgSurface};
          color: ${colors.textPrimary};
          font-family: ${fonts.mono};
        }
        .wsh-header {
          display: flex;
          align-items: center;
          gap: ${spacing.sm};
          padding: ${spacing.sm} ${spacing.md};
          border-bottom: 1px solid ${colors.bgCardHover};
          color: ${colors.textSecondary};
          font-size: ${fonts.sizeXs};
          flex: 0 0 auto;
        }
        .wsh-badge {
          border: 1px solid ${colors.statusWarn}66;
          color: ${colors.statusWarn};
          border-radius: 4px;
          padding: 1px 6px;
          text-transform: uppercase;
          letter-spacing: 0;
        }
        .wsh-spacer {
          flex: 1;
        }
        .wsh-body {
          overflow: auto;
          padding: ${spacing.md};
          min-height: 0;
          flex: 1;
        }
        .wsh-empty {
          color: ${colors.textMuted};
          font-size: ${fonts.sizeSm};
          padding: ${spacing.lg};
        }
        .wsh-empty.error {
          color: ${colors.statusFail};
        }
        .wsh-messages {
          display: flex;
          flex-direction: column;
        }
      </style>
      <div class="wsh-header">
        <span class="wsh-badge">Experimental</span>
        <span>${runner}</span>
        <span>${source}</span>
        ${this.snapshot?.truncated ? html`<span>truncated</span>` : nothing}
        <span class="wsh-spacer"></span>
        ${this.snapshot?.generatedAt
          ? html`<span>${new Date(this.snapshot.generatedAt).toLocaleTimeString()}</span>`
          : nothing}
      </div>
      <div class="wsh-body">${this.renderBody()}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'worker-session-history': WorkerSessionHistoryElement;
  }
}
