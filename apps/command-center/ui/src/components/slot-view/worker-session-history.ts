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
import { applyLegacyConversationDelta } from '@farmslot/protocol/client-cache';

import '../chat/chat-message.js';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

import {
  workerHistoryShowsMessages,
  workerHistorySourceLabel,
} from './worker-session-history-render.js';

@customElement('worker-session-history')
export class WorkerSessionHistoryElement extends LitElement {
  @property() slotId = '';
  @property() runId = '';
  @property() role = '';
  @property() contextId = '';
  /** Dev-harness fixture. Live slot view never sets this. */
  @property({ attribute: false }) snapshotOverride: WorkerSessionHistorySnapshot | null = null;

  @state() private snapshot: WorkerSessionHistorySnapshot | null = null;
  @state() private loading = false;
  @state() private error = '';

  private unsubscribeEvent?: () => void;
  private subscriptionKey = '';
  private snapshotKey = '';
  private subscriptionEpoch = 0;
  private stopConnection?: () => void;
  private stopNode?: () => void;
  private subscriptionConnection?: number | string;
  private subscriptionTarget: ReturnType<WorkerSessionHistoryElement['targetParams']> | null = null;

  protected override createRenderRoot() {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.stopConnection = gateway.onConnectionChange((status) => {
      if (status === 'connected') void this.resubscribe(true);
      else this.pauseHistory();
    });
    this.stopNode = gateway.subscribe(Events.NODE_CONNECTED, () => {
      void this.resubscribe(true);
    });
    document.addEventListener('visibilitychange', this.visibilityChanged);
    void this.resubscribe();
  }
  private readonly visibilityChanged = () => {
    if (document.visibilityState === 'hidden') this.pauseHistory();
    else void this.resubscribe(true);
  };
  private pauseHistory(): void {
    this.subscriptionEpoch++;
    void this.teardownSubscription().catch((error) => {
      this.error = (error as Error).message;
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopConnection?.();
    this.stopNode?.();
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.pauseHistory();
  }

  override updated(changed: Map<string, unknown>): void {
    this.setAttribute('data-testid', 'worker-session-history');
    this.setAttribute('data-source', this.snapshot?.source ?? 'unavailable');
    if (changed.has('snapshotOverride') && this.snapshotOverride) {
      this.snapshot = this.snapshotOverride;
      this.loading = false;
      this.error = '';
      return;
    }
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
      ...(this.slotId ? { slotId: this.slotId } : {}),
      ...(this.runId ? { runId: this.runId } : {}),
      ...(this.role ? { role: this.role } : {}),
      ...(this.contextId ? { contextId: this.contextId } : {}),
    };
  }

  private makeKey(): string {
    const params = this.targetParams();
    return [
      params.slotId ?? '',
      params.runId ?? '',
      params.role ?? '',
      params.contextId ?? '',
    ].join(':');
  }

  private async teardownSubscription(): Promise<void> {
    this.unsubscribeEvent?.();
    this.unsubscribeEvent = undefined;
    const target = this.subscriptionTarget;
    const key = this.subscriptionKey;
    const connection = this.subscriptionConnection;
    this.subscriptionKey = '';
    this.subscriptionTarget = null;
    this.subscriptionConnection = undefined;
    // The old socket's close handler withdraws its subscriptions; a replacement socket must
    // never unsubscribe a new owner's view using this view's old target.
    if (!key || !target || connection !== gateway.resourceConnectionId) return;
    try {
      await gateway.request(Methods.WORKER_SESSION_HISTORY_UNSUBSCRIBE, target, 5_000);
    } catch (error) {
      if (connection !== gateway.resourceConnectionId || gateway.connectionState !== 'connected')
        return;
      throw error;
    }
  }

  private async resubscribe(force = false): Promise<void> {
    if (this.snapshotOverride) {
      this.snapshot = this.snapshotOverride;
      this.loading = false;
      this.error = '';
      return;
    }
    if (!this.isConnected || document.visibilityState === 'hidden' || (!this.slotId && !this.runId))
      return;
    const nextKey = this.makeKey();
    if (!force && nextKey === this.subscriptionKey) return;
    const epoch = ++this.subscriptionEpoch;
    const connection = gateway.resourceConnectionId;
    try {
      await this.teardownSubscription();
    } catch (error) {
      if (epoch === this.subscriptionEpoch) this.error = (error as Error).message;
      return;
    }
    if (
      !this.isConnected ||
      epoch !== this.subscriptionEpoch ||
      connection !== gateway.resourceConnectionId
    )
      return;
    this.loading = this.snapshot === null;
    this.error = '';
    if (this.snapshotKey !== nextKey) this.snapshot = null;
    this.snapshotKey = nextKey;
    this.subscriptionKey = nextKey;
    const target = this.targetParams();
    this.subscriptionTarget = target;
    this.subscriptionConnection = connection;
    this.unsubscribeEvent = gateway.subscribe<WorkerSessionHistoryDeltaPayload>(
      Events.WORKER_SESSION_HISTORY_DELTA,
      (payload) => {
        if (epoch === this.subscriptionEpoch && connection === gateway.resourceConnectionId)
          this.applyDelta(payload);
      },
    );
    try {
      const result = await gateway.request<WorkerSessionHistorySubscribeResult>(
        Methods.WORKER_SESSION_HISTORY_SUBSCRIBE,
        { ...target, limit: 300 },
        20_000,
      );
      if (
        !this.isConnected ||
        epoch !== this.subscriptionEpoch ||
        this.makeKey() !== nextKey ||
        connection !== gateway.resourceConnectionId
      ) {
        if (
          result.subscribed &&
          this.subscriptionKey !== nextKey &&
          connection === gateway.resourceConnectionId
        )
          await gateway.request(Methods.WORKER_SESSION_HISTORY_UNSUBSCRIBE, target, 5_000);
        return;
      }
      this.snapshot = result.snapshot;
    } catch (err) {
      if (!this.isConnected || epoch !== this.subscriptionEpoch || this.makeKey() !== nextKey)
        return;
      this.error = (err as Error).message;
    } finally {
      if (epoch === this.subscriptionEpoch && this.makeKey() === nextKey) this.loading = false;
    }
  }

  private applyDelta(payload: WorkerSessionHistoryDeltaPayload): void {
    if (this.snapshot)
      this.snapshot = applyLegacyConversationDelta(this.snapshot, payload, this.targetParams());
  }

  private short(value: string | null | undefined, length = 8): string {
    if (!value) return '';
    return value.length > length ? value.slice(0, length) : value;
  }

  private targetSummary(): string[] {
    const snapshot = this.snapshot;
    if (!snapshot) return [];
    const items: string[] = [];
    if (snapshot.runId) items.push(`Run ${this.short(snapshot.runId)}`);
    if (snapshot.role || snapshot.contextId) {
      items.push(snapshot.role ?? snapshot.contextId ?? 'context');
    }
    const engine = [snapshot.runner, snapshot.model].filter(Boolean).join(' / ');
    if (engine) items.push(engine);
    if (snapshot.runnerSessionId) items.push(`Session ${this.short(snapshot.runnerSessionId)}`);
    return items;
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
    if (!workerHistoryShowsMessages(this.snapshot.source) && !this.snapshot.messages.length) {
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
    const target = this.targetSummary();
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
          flex-wrap: wrap;
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
        .wsh-meta {
          color: ${colors.textSecondary};
        }
        .wsh-source {
          color: ${colors.textMuted};
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
        ${target.length > 0
          ? target.map((item) => html`<span class="wsh-meta">${item}</span>`)
          : html`<span class="wsh-meta">Worker session history</span>`}
        <span class="wsh-source">${workerHistorySourceLabel(source)}</span>
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
