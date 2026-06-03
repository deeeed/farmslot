// <resource-toolbar> — resource chips + control buttons

import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { ResourceControlAction, SlotActionSummary, SlotResource } from '@farmslot/protocol';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

@customElement('resource-toolbar')
export class ResourceToolbar extends LitElement {
  @property({ type: Array }) resources: SlotResource[] = [];
  @property({ type: Array }) activeIds: string[] = [];
  @property({ type: Array }) actions: SlotActionSummary[] = [];
  @property({ type: Array }) runningActionIds: string[] = [];

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border: 1px solid #2a2a44;
      border-radius: 10px;
      background: transparent;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 9px;
      color: ${unsafeCSS(colors.textMuted)};
      cursor: pointer;
      transition: all 0.15s;
      user-select: none;
    }

    .chip.no-stream {
      cursor: default;
    }

    .chip:hover {
      background: rgba(99, 102, 241, 0.08);
      color: ${unsafeCSS(colors.textSecondary)};
      border-color: #3a3a54;
    }

    .chip.active {
      background: ${unsafeCSS(colors.accent)}18;
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)}44;
    }

    .chip.active:hover {
      background: ${unsafeCSS(colors.accent)}28;
    }

    .dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: ${unsafeCSS(colors.textMuted)};
      flex-shrink: 0;
    }

    .dot.active {
      background: ${unsafeCSS(colors.statusOk)};
    }

    .dot.running {
      background: ${unsafeCSS(colors.statusOk)};
    }

    .dot.stopped {
      background: ${unsafeCSS(colors.statusFail)};
    }

    .dot.error {
      background: ${unsafeCSS(colors.statusFail)};
    }

    .controls {
      display: flex;
      gap: 2px;
      margin-left: 4px;
    }

    .stream-badge {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 8px;
      padding: 0 4px;
      border-radius: 8px;
      border: 1px solid transparent;
      flex-shrink: 0;
    }

    .stream-badge.ready {
      color: ${unsafeCSS(colors.statusOk)};
      border-color: ${unsafeCSS(colors.statusOk)}44;
      background: ${unsafeCSS(colors.statusOk)}18;
    }

    .stream-badge.starting {
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)}44;
      background: ${unsafeCSS(colors.accent)}18;
    }

    .stream-badge.error {
      color: ${unsafeCSS(colors.statusWarn)};
      border-color: ${unsafeCSS(colors.statusWarn)}44;
      background: ${unsafeCSS(colors.statusWarn)}18;
    }

    .ctrl-btn {
      padding: 1px 5px;
      border: 1px solid #2a2a44;
      border-radius: 3px;
      background: transparent;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 8px;
      color: ${unsafeCSS(colors.textMuted)};
      cursor: pointer;
      transition: all 0.1s;
    }

    .ctrl-btn:hover {
      background: rgba(99, 102, 241, 0.12);
      color: ${unsafeCSS(colors.textSecondary)};
    }

    .ctrl-btn.danger {
      color: ${unsafeCSS(colors.statusFail)};
      border-color: ${unsafeCSS(colors.statusFail)}44;
    }

    .ctrl-btn.primary {
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)}44;
    }

    .ctrl-btn:disabled {
      cursor: wait;
      opacity: 0.55;
    }
  `;

  private _onChipClick(resource: SlotResource) {
    if (!resource.definition.streamable) return;
    const isActive = this.activeIds.includes(resource.id);
    this.dispatchEvent(
      new CustomEvent('resource-toggle', {
        detail: { resourceId: resource.id, active: !isActive },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onControl(resourceId: string, action: ResourceControlAction) {
    this.dispatchEvent(
      new CustomEvent('resource-control', {
        detail: { resourceId, action },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onSlotAction(actionId: string) {
    this.dispatchEvent(
      new CustomEvent('slot-action-run', {
        detail: { actionId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _resourceActions(resourceId: string): SlotActionSummary[] {
    return this.actions.filter(
      (action) => action.resourceId === resourceId && action.placement.includes('resource-panel'),
    );
  }

  render() {
    return html`
      ${this.resources.map((r) => {
        const active = this.activeIds.includes(r.id);
        const dotClass = active ? 'active' : r.status;
        const streamable = r.definition.streamable;
        const streamBadge =
          !streamable || !r.stream || r.stream.state === 'unknown'
            ? nothing
            : html`<span
                class="stream-badge ${r.stream.state === 'ready'
                  ? 'ready'
                  : r.stream.state === 'starting'
                    ? 'starting'
                    : 'error'}"
                title=${r.stream.detail ??
                (r.stream.state === 'ready'
                  ? 'Live view ready'
                  : r.stream.state === 'starting'
                    ? 'Live view starting'
                    : 'Live view error')}
                >${r.stream.state === 'ready'
                  ? 'live'
                  : r.stream.state === 'starting'
                    ? '...'
                    : '!'}</span
              >`;
        return html`
          <button
            class="chip ${active ? 'active' : ''} ${!streamable ? 'no-stream' : ''}"
            @click=${() => this._onChipClick(r)}
            title="${r.definition.label} (${r.status}${r.stream?.state &&
            r.stream.state !== 'unknown'
              ? `, stream ${r.stream.state}`
              : ''}${r.stream?.detail ? `: ${r.stream.detail}` : ''})"
          >
            <span class="dot ${dotClass}"></span>
            ${r.definition.label} ${streamBadge}
          </button>
          ${!streamable && r.definition.controllable
            ? html`
                <div class="controls">
                  ${r.status === 'stopped' && r.definition.hooks?.boot
                    ? html`
                        <button
                          class="ctrl-btn"
                          @click=${() => this._onControl(r.id, 'boot')}
                          title="Boot"
                        >
                          On
                        </button>
                      `
                    : nothing}
                  ${r.status === 'running' && r.definition.hooks?.shutdown
                    ? html`
                        <button
                          class="ctrl-btn"
                          @click=${() => this._onControl(r.id, 'shutdown')}
                          title="Shutdown"
                        >
                          Off
                        </button>
                      `
                    : nothing}
                </div>
              `
            : nothing}
          ${active && streamable && r.definition.controllable
            ? html`
                <div class="controls">
                  ${r.definition.hooks?.relaunch
                    ? html`
                        <button
                          class="ctrl-btn"
                          @click=${() => this._onControl(r.id, 'relaunch')}
                          title="Relaunch"
                        >
                          RL
                        </button>
                      `
                    : nothing}
                  ${r.status === 'stopped' && r.definition.hooks?.boot
                    ? html`
                        <button
                          class="ctrl-btn"
                          @click=${() => this._onControl(r.id, 'boot')}
                          title="Boot"
                        >
                          On
                        </button>
                      `
                    : nothing}
                  ${r.status === 'running' && r.definition.hooks?.shutdown
                    ? html`
                        <button
                          class="ctrl-btn"
                          @click=${() => this._onControl(r.id, 'shutdown')}
                          title="Shutdown"
                        >
                          Off
                        </button>
                      `
                    : nothing}
                </div>
              `
            : nothing}
          ${this._resourceActions(r.id).length > 0
            ? html`
                <div class="controls">
                  ${this._resourceActions(r.id).map(
                    (action) => html`
                      <button
                        class="ctrl-btn ${action.style}"
                        ?disabled=${this.runningActionIds.includes(action.id)}
                        @click=${() => this._onSlotAction(action.id)}
                        title=${action.confirm ?? action.label}
                      >
                        ${this.runningActionIds.includes(action.id) ? '...' : action.label}
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing}
        `;
      })}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'resource-toolbar': ResourceToolbar;
  }
}
