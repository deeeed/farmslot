import { html, nothing } from 'lit';

import type { NativeSessionInfo } from '@farmslot/protocol';

import { nativeReadStatus } from './native-read-status.js';
import type { NativeWorkerViewTarget } from './native-worker-target.js';

interface NativeSessionHeaderContext {
  worker?: NativeWorkerViewTarget;
  sessions: NativeSessionInfo[];
  selectedId: string;
  selectedNodeId: string;
  session?: NativeSessionInfo;
  connected: boolean;
  caughtUp: boolean;
  refreshingHistory?: boolean;
  busy: boolean;
  workspace: boolean;
  workspaceAllowed: boolean;
  taskHistory: boolean;
  fullscreen: boolean;
  toggleFullscreen(): void;
  requestCount: number;
  sessionChoice(session: Pick<NativeSessionInfo, 'id' | 'executionNodeId'>): string;
  select(id: string, node?: string): void;
  readError?: string;
  unavailableSince?: number;
  observedAt?: number;
  savedHistory?: boolean;
  unsupported?: boolean;
  now?: number;
  refresh(): void;
  toggleWorkspace(): void;
}

export function renderNativeSessionHeader(ctx: NativeSessionHeaderContext) {
  const session = ctx.session;
  const status = nativeReadStatus({
    ...ctx,
    selected: Boolean(ctx.selectedId),
    sessionState: session?.state,
    saved: ctx.savedHistory,
    now: ctx.now ?? Date.now(),
  });
  return html`
    <div class="bar">
      ${ctx.worker
        ? html`<strong data-testid="native-worker-label">${ctx.worker.label}</strong>
            <a href=${`#run/${ctx.worker.runId}`}>Task controls</a>`
        : html`<label class="inline"
              >Session<select
                data-testid="native-session-select"
                @change=${(e: Event) => {
                  const value = (e.target as HTMLSelectElement).value;
                  const selected = ctx.sessions.find((item) => ctx.sessionChoice(item) === value);
                  if (selected) ctx.select(selected.id, selected.executionNodeId);
                  else if (!value) ctx.select('');
                }}
              >
                <option value="" .selected=${!ctx.selectedId}>New session</option>
                ${ctx.selectedId &&
                !ctx.sessions.some(
                  (item) =>
                    item.id === ctx.selectedId && item.executionNodeId === ctx.selectedNodeId,
                )
                  ? html`<option
                      .selected=${true}
                      value=${ctx.sessionChoice({
                        id: ctx.selectedId,
                        executionNodeId: ctx.selectedNodeId,
                      })}
                    >
                      ${ctx.selectedNodeId} · ${ctx.selectedId.slice(0, 8)} · Unavailable
                    </option>`
                  : nothing}
                ${ctx.sessions.map(
                  (item) =>
                    html`<option
                      value=${ctx.sessionChoice(item)}
                      .selected=${item.id === ctx.selectedId &&
                      item.executionNodeId === ctx.selectedNodeId}
                    >
                      ${item.runner} · ${item.model ?? 'default'} · ${item.cwd.split('/').at(-1)} ·
                      ${item.executionNodeId} · ${item.profileId ?? 'node default'} ·
                      ${item.id.slice(0, 8)} · ${item.state}
                    </option>`,
                )}
              </select></label
            >
            <button data-testid="native-new" ?disabled=${ctx.busy} @click=${() => ctx.select('')}>
              New session
            </button> `}
      ${session && ctx.workspaceAllowed
        ? html`<button
            aria-pressed=${ctx.workspace}
            data-testid="native-workspace-toggle"
            @click=${ctx.toggleWorkspace}
          >
            ${ctx.workspace ? 'Conversation' : 'Files / Changes'}${ctx.requestCount
              ? ` · ${ctx.requestCount} waiting`
              : ''}
          </button>`
        : nothing}
      <button data-testid="native-fullscreen" @click=${ctx.toggleFullscreen}>
        ${ctx.fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      </button>
    </div>
    <div class="native-read-status" data-testid="native-read-status" data-state=${status.state}>
      <div class="native-read-status-text">
        <span
          class="status"
          role="status"
          data-state=${status.state === 'ready' && session ? session.state : status.state}
          >${status.text}</span
        >
        <span
          class="meta"
          data-testid=${ctx.savedHistory && ctx.observedAt !== undefined
            ? 'native-history-saved'
            : 'native-history-age'}
          data-observed-at=${ctx.observedAt ?? ''}
          >${status.age}</span
        >
      </div>
      ${status.retry
        ? html`<button data-testid="native-refresh" @click=${ctx.refresh}>Retry</button>`
        : nothing}
    </div>
  `;
}
