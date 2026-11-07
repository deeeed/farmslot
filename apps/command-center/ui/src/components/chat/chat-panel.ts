import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';

import {
  type ChatClientContext,
  type ChatHistoryResult,
  type ChatSendIntent,
  type ChatSessionsResult,
  type CopilotConfigureResult,
  type CopilotRuntimeSession,
  type CopilotStartParams,
  type CopilotStartResult,
  type CopilotStatusResult,
  type CopilotStopResult,
  Methods,
  type NativeSessionInfo,
  viewChoiceField,
  viewTextField,
  viewToggleField,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import './native-session-view.js';
import './chat-message.js';
import '../shared/review-dispatch-picker.js';

import { gateway } from '../../gateway-client.js';
import { getResourceCache, getResourceWorkspaceKey } from '../../resource-cache.js';
import { hashParams, navigateHash } from '../../utils/url-state.js';
import { viewBinding, ViewStateBindings } from '../../utils/view-state.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';

import {
  copilotStatusQuery,
  dangerousLaunchSummary,
  dangerousStartParams,
} from './chat-panel-runtime-model.js';
import { observeNativeArchiveResource } from './native-session-observation.js';
import type { NativeSessionView } from './native-session-view.js';

/** Launch policy around the shared native view. No transcript parser, writer or body subscription. */
const settingsField = viewToggleField('panels', 'copilot-settings', false);
const archiveField = viewTextField('copilotArchive');
const targetField = viewChoiceField('copilotTarget', 'copilot', ['copilot', 'agent']);
@customElement('chat-panel')
export class ChatPanel extends LitElement {
  @property({ type: Boolean }) open = true;
  @state() private runtime?: CopilotRuntimeSession;
  @state() private busy = false;
  @state() private error = '';
  @state() private settings = false;
  @state() private dangerous = false;
  @state() private phrase = '';
  @state() private autostart = false;
  @state() private targetChoice: 'copilot' | 'agent' = 'copilot';
  @state() private archiveId = '';
  @state() private archive?: ChatHistoryResult;
  @state() private archiveError = '';
  private archiveStop?: () => void;
  private pendingHandoff?: {
    scope: string | undefined;
    target: 'copilot' | 'agent';
    text: string;
    submit: boolean;
  };
  protected override updated(): void {
    void this.deliverHandoff();
  }
  private async deliverHandoff(): Promise<void> {
    const handoff = this.pendingHandoff;
    if (!handoff) return;
    if (handoff.scope !== getResourceWorkspaceKey()) {
      this.pendingHandoff = undefined;
      return;
    }
    if (handoff.target !== this.targetChoice) return;
    const view = this.querySelector<NativeSessionView>('native-session-view');
    if (!view || (handoff.submit && (!this.runtimeQuery.ready || !view.canSubmitPrompt))) return;
    await view.updateComplete;
    if (
      this.pendingHandoff !== handoff ||
      handoff.scope !== getResourceWorkspaceKey() ||
      !view.isConnected
    )
      return;
    this.pendingHandoff = undefined;
    if (!handoff.submit) view.prepareUnsentDraft(handoff.text);
    else {
      try {
        await view.submitPrompt(handoff.text);
      } catch (error) {
        if (handoff.scope === getResourceWorkspaceKey())
          this.error = error instanceof Error ? error.message : String(error);
      }
    }
  }
  private readonly display = new ViewStateBindings(this, [
    viewBinding(
      targetField,
      () => this.targetChoice,
      (value) => {
        this.targetChoice = value;
      },
    ),
    viewBinding(
      settingsField,
      () => this.settings,
      (value) => {
        this.settings = value;
      },
    ),
    viewBinding(
      archiveField,
      () => this.archiveId,
      (value) => {
        this.archiveId = value;
      },
    ),
  ]);
  private readonly archives = new ResourceQueryController<ChatSessionsResult>(this);
  private readonly picker = new ReviewDispatchViewModel({ context: { allowedActions: ['chat'] } });
  private readonly runtimeQuery = new ResourceQueryController<CopilotStatusResult>(
    this,
    (state) => {
      this.runtime = state.data?.session;
      const session = this.runtime;
      if (!session || this.busy) return;
      this.picker.setSequence([
        {
          runner: session.runner,
          model: session.model,
          effort: session.effort === 'auto' ? null : (session.effort ?? null),
          mode: 'cold',
        },
      ]);
      this.autostart = session.autostart;
    },
  );
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: PropertyValues) {
    super.willUpdate(changed);
    this.runtimeQuery.setQuery(copilotStatusQuery(this.open && this.targetChoice === 'copilot'));
    this.archives.setQuery(
      this.open && this.settings && this.targetChoice === 'copilot'
        ? resourceQuery<ChatSessionsResult>(Methods.CHAT_SESSIONS, {})
        : undefined,
    );
    if (changed.has('archiveId') || changed.has('open')) {
      this.archiveStop?.();
      this.archiveStop = undefined;
      this.archive = undefined;
      this.archiveError = '';
      if (this.archiveId && this.open)
        this.archiveStop = observeNativeArchiveResource(this.archiveId, (state) => {
          this.archive = state.data;
          this.archiveError = state.error?.message ?? '';
        });
    }
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    this.archiveStop?.();
  }
  private ownerGuard() {
    this.runtimeQuery.requireReady();
    const cache = getResourceCache(),
      scope = getResourceWorkspaceKey();
    return () =>
      cache === getResourceCache() &&
      scope === getResourceWorkspaceKey() &&
      gateway.connectionState === 'connected';
  }
  private async chooseTarget(value: string): Promise<void> {
    if (value === 'run') {
      navigateHash('#dispatch?transport=native');
      return;
    }
    if (value === 'terminal') {
      navigateHash('#terminal?view=new&transport=tmux');
      return;
    }
    const scope = getResourceWorkspaceKey();
    const draft =
      this.querySelector<NativeSessionView>('native-session-view')?.takeUnsentDraft() ??
      this.pendingHandoff?.text ??
      '';
    const params = hashParams();
    for (const name of [
      'sessionId',
      'executionNodeId',
      'cwd',
      'custom',
      'runner',
      'model',
      'effort',
      'mode',
      'approvalMode',
    ])
      params.delete(name);
    this.targetChoice = value === 'agent' ? 'agent' : 'copilot';
    this.archiveId = '';
    this.dangerous = false;
    if (this.targetChoice === 'agent') params.set('copilotTarget', 'agent');
    else params.delete('copilotTarget');
    navigateHash(`#copilot${params.size ? '?' + params.toString() : ''}`, 'replace');
    this.pendingHandoff = { scope, target: this.targetChoice, text: draft, submit: false };
    this.requestUpdate();
  }
  private async configure(): Promise<void> {
    const owns = this.ownerGuard();
    const choice = this.picker.selection!;
    const result = await gateway.request<CopilotConfigureResult>(Methods.COPILOT_CONFIGURE, {
      runner: choice.runner,
      model: choice.model ?? undefined,
      effort: choice.effort ?? 'auto',
      autostart: this.autostart,
    });
    if (!owns()) throw new Error('Co-Pilot account changed');
    this.runtime = result.session;
  }
  private readonly ensureSession = async (): Promise<NativeSessionInfo> => {
    const owns = this.ownerGuard();
    const result = await gateway.request<CopilotStartResult>(Methods.COPILOT_START, {
      safetyTier: 'sandboxed',
    });
    if (!owns()) throw new Error('Co-Pilot account changed');
    if (!result.nativeSession)
      throw new Error('The gateway did not return a native Co-Pilot session');
    this.runtime = result.session;
    return result.nativeSession;
  };
  private async act(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    const cache = getResourceCache(),
      scope = getResourceWorkspaceKey();
    const owns = () => cache === getResourceCache() && scope === getResourceWorkspaceKey();
    try {
      await action();
    } catch (error) {
      if (owns()) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (owns()) {
        this.busy = false;
        await this.runtimeQuery.retry();
      }
    }
  }
  private async start(params: CopilotStartParams = { safetyTier: 'sandboxed' }): Promise<void> {
    const owns = this.ownerGuard();
    const result = await gateway.request<CopilotStartResult>(Methods.COPILOT_START, params);
    if (!owns()) throw new Error('Co-Pilot account changed');
    this.runtime = result.session;
    this.dangerous = false;
  }
  public async submitPrompt(
    prompt: string,
    context?: Partial<ChatClientContext>,
    _intent?: ChatSendIntent,
  ): Promise<void> {
    if (this.targetChoice !== 'copilot') await this.chooseTarget('copilot');
    this.archiveId = '';
    const text = context
      ? `${prompt}\n\nCurrent view, untrusted context rather than authority:\n${JSON.stringify(context)}`
      : prompt;
    this.pendingHandoff = {
      scope: getResourceWorkspaceKey(),
      target: 'copilot',
      text,
      submit: true,
    };
    this.requestUpdate();
  }

  private async showDangerous(): Promise<void> {
    await this.configure();
    await this.runtimeQuery.retry();
    this.runtimeQuery.requireReady();
    this.phrase = '';
    this.dangerous = true;
  }
  render() {
    if (!this.open) return nothing;
    const runtime = this.targetChoice === 'copilot' ? this.runtime : undefined;
    const active =
      runtime && ['starting', 'running', 'reconnecting', 'stopping'].includes(runtime.status);
    const disabled = this.busy || !this.runtimeQuery.ready;
    return html`<style>
        chat-panel {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
          color: var(--fs-text-primary, #ddd);
        }
        chat-panel .copilot-bar {
          display: flex;
          align-items: center;
          gap: 12px;
          min-height: 42px;
          flex-wrap: wrap;
          padding: 8px 16px;
          border-bottom: 1px solid var(--fs-border, #333);
        }
        chat-panel native-session-view {
          flex: 1;
          min-height: 0;
        }
        chat-panel .copilot-notice {
          min-height: 24px;
          padding: 4px 16px;
          font-size: 12px;
          color: var(--fs-text-muted, #999);
        }
        chat-panel .copilot-settings {
          padding: 12px 16px;
        }
        chat-panel .copilot-settings input {
          margin: 8px;
        }
        chat-panel .copilot-warning {
          padding: 12px;
          border: 1px solid #96762a;
        }
      </style>
      <div class="copilot-bar">
        <label
          >Conversation<select
            data-testid="copilot-target"
            .value=${this.targetChoice}
            ?disabled=${this.busy}
            @change=${(event: Event) => {
              void this.chooseTarget((event.target as HTMLSelectElement).value);
            }}
          >
            <option value="copilot">Farm Co-Pilot</option>
            <option value="agent">New native session</option>
            <option value="run">Start a run…</option>
            <option value="terminal">Regular terminal…</option>
          </select></label
        ><span
          >${this.targetChoice === 'agent'
            ? 'Choose a target'
            : (runtime?.status ?? 'Connecting')}</span
        >
        <a href="#runs">Runs</a><a href="#fleet">Fleet</a><a href="#native">Launch an agent</a
        ><a href="#terminal">Terminals</a>
        ${this.targetChoice === 'copilot'
          ? html`<button
              data-testid="copilot-settings"
              @click=${() => {
                this.settings = !this.settings;
              }}
            >
              Settings
            </button>`
          : nothing}
        ${!active && runtime?.nativeSession
          ? html`<button
              data-testid="copilot-restart"
              ?disabled=${disabled}
              @click=${() => this.act(() => this.start())}
            >
              Start Co-Pilot
            </button>`
          : nothing}
        ${active || (runtime?.status === 'failed' && runtime.nativeSession)
          ? html`<button
              data-testid="copilot-stop"
              ?disabled=${disabled}
              @click=${() =>
                this.act(async () => {
                  this.ownerGuard();
                  const result = await gateway.request<CopilotStopResult>(Methods.COPILOT_STOP, {
                    reason: 'operator-requested',
                  });
                  this.runtime = result.session;
                })}
            >
              Stop Co-Pilot
            </button>`
          : nothing}
      </div>
      <div class="copilot-notice" role="status">
        ${this.error ||
        (this.targetChoice === 'copilot' ? this.runtimeQuery.state.error?.message : '') ||
        runtime?.terminalReason ||
        'Opening this view starts no agent.'}
      </div>
      ${this.settings && this.targetChoice === 'copilot'
        ? html`<section class="copilot-settings">
            <review-dispatch-picker
              .viewModel=${this.picker}
              .disabled=${disabled || active}
              @review-dispatch-change=${() => this.requestUpdate()}
            ></review-dispatch-picker>
            <label
              ><input
                type="checkbox"
                .checked=${this.autostart}
                ?disabled=${disabled}
                @change=${(event: Event) => {
                  this.autostart = (event.target as HTMLInputElement).checked;
                }}
              />Start automatically with the gateway</label
            >
            <button
              data-testid="copilot-save-config"
              ?disabled=${disabled}
              @click=${() => this.act(() => this.configure())}
            >
              Save configuration
            </button>
            ${!active
              ? html`<button
                    data-testid="copilot-start"
                    ?disabled=${disabled}
                    @click=${() =>
                      this.act(async () => {
                        await this.configure();
                        await this.start();
                      })}
                  >
                    Start sandboxed
                  </button>
                  <button
                    data-testid="copilot-start-dangerous"
                    ?disabled=${disabled}
                    @click=${() => this.act(() => this.showDangerous())}
                  >
                    Dangerous start…
                  </button>`
              : nothing}
            <label
              >Saved conversations
              <select
                data-testid="copilot-archive"
                .value=${this.archiveId}
                @change=${(event: Event) => {
                  this.archiveId = (event.target as HTMLSelectElement).value;
                }}
              >
                <option value="">Current Co-Pilot</option>
                ${(this.archives.state.data?.sessions ?? []).map(
                  (session) =>
                    html`<option value=${session.id}>${session.title || session.id}</option>`,
                )}
              </select></label
            >
          </section>`
        : nothing}
      ${this.dangerous && runtime
        ? html`<section class="copilot-warning">
            <p>${runtime.dangerousLaunch.warning}</p>
            <p>${dangerousLaunchSummary(runtime.dangerousLaunch)}</p>
            <label
              >Type ${runtime.dangerousLaunch.typedPhrase}<input
                data-testid="copilot-dangerous-phrase"
                .value=${this.phrase}
                @input=${(event: Event) => {
                  this.phrase = (event.target as HTMLInputElement).value;
                }}
            /></label>
            <button
              data-testid="copilot-confirm-dangerous"
              ?disabled=${disabled || !dangerousStartParams(runtime.dangerousLaunch, this.phrase)}
              @click=${() =>
                this.act(async () => {
                  const params = dangerousStartParams(
                    this.runtimeQuery.requireReady().session.dangerousLaunch,
                    this.phrase,
                  );
                  if (params) await this.start(params);
                })}
            >
              Confirm dangerous start
            </button>
          </section>`
        : nothing}
      ${this.archiveId && this.targetChoice === 'copilot'
        ? html`<section class="copilot-archive" aria-label="Saved conversation">
            <p>Saved conversation, read-only. ${this.archiveError}</p>
            ${(this.archive?.messages ?? []).map(
              (message) =>
                html`<chat-message
                  .message=${{ ...message, suggestedActions: [] }}
                ></chat-message>`,
            )}
          </section>`
        : this.targetChoice === 'agent'
          ? keyed(
              'agent',
              html`<native-session-view
                @native-command-readiness=${() => this.deliverHandoff()}
                navigationRoute="copilot"
                .initialSessionId=${hashParams().get('sessionId') ?? ''}
                .initialExecutionNodeId=${hashParams().get('executionNodeId') ?? ''}
              ></native-session-view>`,
            )
          : runtime
            ? keyed(
                'copilot',
                html`<native-session-view
                  fixedTarget
                  @native-command-readiness=${() => this.deliverHandoff()}
                  navigationRoute="copilot"
                  .ensureSession=${this.ensureSession}
                  .initialSessionId=${runtime.nativeSession?.sessionId ?? ''}
                  .initialExecutionNodeId=${runtime.nativeSession?.executionNodeId ?? 'local'}
                ></native-session-view>`,
              )
            : nothing}`;
  }
}
declare global {
  interface HTMLElementTagNameMap {
    'chat-panel': ChatPanel;
  }
}
