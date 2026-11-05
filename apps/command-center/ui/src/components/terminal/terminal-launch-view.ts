import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  Methods,
  type NodesListResult,
  type TmuxWorkerCreateSessionResult,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import '../chat/native-session-view.js';
import '../shared/choice-picker.js';

import { gateway } from '../../gateway-client.js';
import { getResourceWorkspaceKey } from '../../resource-cache.js';
import { getState, subscribe } from '../../state.js';
import { colors, fonts } from '../../styles/theme-tokens.js';
import { buildHash, hashParams, navigateHash } from '../../utils/url-state.js';
import type { ChoicePicker } from '../shared/choice-picker.js';
import { planningChoiceStyles, renderChoiceButtons } from '../shared/planning-controls.js';
import { canActOn, ResourceQueryController } from '../shared/resource-query-controller.js';

import { encodeWorkerRouteParam } from './split-view-model.js';

/** One entry point; native creation/conversation stays in the shipped shared launcher. */
@customElement('terminal-launch-view')
export class TerminalLaunchView extends LitElement {
  @property() selection = '';
  @state() private busy = false;
  @state() private error = '';
  private stopFilters?: () => void;
  connectedCallback() {
    super.connectedCallback();
    this.stopFilters = subscribe(() => this.requestUpdate());
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopFilters?.();
  }
  private readonly nodes = new ResourceQueryController<NodesListResult>(this);

  static styles = [
    planningChoiceStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        color: ${unsafeCSS(colors.textPrimary)};
        font-family: ${unsafeCSS(fonts.mono)};
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 16px;
        padding: 12px 16px;
        border-bottom: 1px solid #2a2a44;
        flex-shrink: 0;
      }
      a {
        color: ${unsafeCSS(colors.accent)};
        font-size: 12px;
      }
      native-session-view {
        flex: 1;
        min-height: 0;
      }
      .terminal-form {
        padding: 24px;
        max-width: 520px;
      }
      label {
        display: grid;
        gap: 8px;
        margin-bottom: 16px;
        font-size: 12px;
      }
      button {
        font: inherit;
        color: inherit;
        padding: 8px 12px;
        border: 1px solid #2a2a44;
        border-radius: 5px;
        background: ${unsafeCSS(colors.bgSurface)};
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .notice {
        min-height: 36px;
        font-size: 12px;
        color: ${unsafeCSS(colors.statusWarn)};
      }
    `,
  ];

  private get params() {
    return new URLSearchParams(this.selection);
  }
  private get transport() {
    return this.params.get('transport') === 'tmux' ? 'tmux' : 'native';
  }
  private get machines() {
    const filters = getState().globalFilters.machines;
    return (this.nodes.state.data?.nodes ?? []).filter(
      (node) => !filters.length || filters.includes(node.machine),
    );
  }
  private get machine() {
    return this.params.get('executionNodeId') ?? this.machines[0]?.machine ?? '';
  }

  private get unavailableReason() {
    if (this.nodes.state.status === 'loading') return 'Loading machines…';
    if (!this.machine) return 'No connected machine is available.';
    if (!this.machines.some((node) => node.machine === this.machine))
      return (this.nodes.state.data?.nodes ?? []).some((node) => node.machine === this.machine)
        ? 'Selected machine is outside the Machines filter.'
        : 'Selected machine is not connected.';
    return '';
  }

  protected updated() {
    this.nodes.setQuery(
      this.transport === 'tmux' ? resourceQuery<NodesListResult>(Methods.NODES_LIST) : undefined,
    );
  }
  private navigate(transport: string, machine?: string) {
    // The native launcher updates the address without remounting this wrapper.
    const params = hashParams();
    params.set('view', 'new');
    params.set('transport', transport);
    params.delete('sessionId');
    if (machine && machine !== params.get('executionNodeId')) {
      params.set('executionNodeId', machine);
      params.delete('cwd');
      params.delete('custom');
    }
    this.error = '';
    navigateHash(buildHash('terminal', params));
  }
  private async createTerminal() {
    if (
      this.busy ||
      !this.nodes.belongsToWorkspace ||
      !canActOn(this.nodes.state) ||
      !this.machines.some((node) => node.machine === this.machine)
    )
      return;
    const selection = location.hash;
    const workspace = getResourceWorkspaceKey();
    const connection = gateway.resourceConnectionId;
    this.busy = true;
    this.error = '';
    try {
      const { worker } = await gateway.request<TmuxWorkerCreateSessionResult>(
        Methods.TMUX_WORKER_CREATE_SESSION,
        { nodeId: this.machine },
      );
      if (
        !this.isConnected ||
        location.hash !== selection ||
        workspace !== getResourceWorkspaceKey() ||
        connection !== gateway.resourceConnectionId
      )
        return;
      navigateHash(
        buildHash('terminal', new URLSearchParams({ worker: encodeWorkerRouteParam(worker) })),
      );
    } catch (error) {
      this.error =
        (error instanceof Error ? error.message : String(error)) +
        '. Check the session list before creating another terminal.';
    } finally {
      this.busy = false;
    }
  }
  render() {
    const params = this.params;
    return html`
      <div class="toolbar">
        <a href="#terminal">← Terminals</a>
        ${renderChoiceButtons({
          options: ['native', 'tmux'],
          labels: { native: 'Native session', tmux: 'Terminal' },
          value: this.transport,
          testId: 'terminal-launch-transport',
          disabled: this.busy,
          onSelect: (value) => this.navigate(value),
        })}
      </div>
      ${this.transport === 'native'
        ? html`<native-session-view
            navigationRoute="terminal"
            .initialSessionId=${params.get('sessionId') ?? ''}
            .initialExecutionNodeId=${params.get('executionNodeId') ?? ''}
          ></native-session-view>`
        : html` <div class="terminal-form">
            <label
              >Machine<choice-picker
                data-testid="terminal-launch-machine"
                .value=${this.machine}
                .disabled=${this.busy || !canActOn(this.nodes.state)}
                @change=${(event: Event) =>
                  this.navigate('tmux', (event.target as ChoicePicker).value)}
              >
                ${this.machines.map(
                  (node) => html`<option value=${node.machine}>${node.machine}</option>`,
                )}
              </choice-picker></label
            >
            <div class="notice" role="status" aria-live="polite">
              ${this.error || this.nodes.state.error?.message || this.unavailableReason}
            </div>
            <button
              data-testid="terminal-create"
              ?disabled=${this.busy ||
              !this.nodes.belongsToWorkspace ||
              !canActOn(this.nodes.state) ||
              !this.machines.some((node) => node.machine === this.machine)}
              @click=${() => this.createTerminal()}
            >
              ${this.busy ? 'Starting…' : 'Start terminal'}
            </button>
          </div>`}
    `;
  }
}
