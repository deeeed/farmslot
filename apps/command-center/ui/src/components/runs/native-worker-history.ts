import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';

import type { AgentContext } from '@farmslot/protocol';

import '../chat/native-session-view.js';

import {
  archivedNativeWorkerTargets,
  nativeWorkerViewKey,
  type NativeWorkerViewTarget,
} from '../chat/native-worker-target.js';

@customElement('native-worker-history')
export class NativeWorkerHistory extends LitElement {
  @property({ attribute: false }) contexts: AgentContext[] = [];
  @state() private selected = '';

  static styles = css`
    :host {
      display: block;
    }
    label {
      display: grid;
      gap: 6px;
      margin-top: 12px;
    }
    select {
      font: inherit;
      color: inherit;
      background: #171720;
      padding: 7px;
    }
    native-session-view {
      display: flex;
      height: 600px;
      max-height: 75vh;
      overflow: hidden;
      margin-top: 12px;
    }
    native-session-view:fullscreen {
      height: 100vh;
      max-height: none;
      margin: 0;
    }
  `;

  render() {
    const current: NativeWorkerViewTarget[] = this.contexts.flatMap((context) =>
      !context.slotId && context.nativeSession?.generation
        ? [
            {
              runId: context.runId,
              contextId: context.id,
              label: context.label,
              binding: context.nativeSession,
              readOnly: Boolean(context.nativeSession.closedAt || context.nativeSession.releasedAt),
            },
          ]
        : [],
    );
    const attempts = [...current, ...archivedNativeWorkerTargets(this.contexts)];
    if (!attempts.length) return nothing;
    const attemptKey = (target: (typeof attempts)[number]) =>
      JSON.stringify([nativeWorkerViewKey(target), target.binding.generation]);
    const selected = attempts.find((target) => attemptKey(target) === this.selected);
    return html`
      <label
        >${current.length ? 'Reviewer conversation' : 'Previous worker attempts'}
        <select
          data-testid="native-worker-history-select"
          .value=${selected ? this.selected : ''}
          @change=${(event: Event) => {
            this.selected = (event.target as HTMLSelectElement).value;
          }}
        >
          <option value="" .selected=${!selected}>Choose task history</option>
          ${attempts.map(
            (target) => html`
              <option value=${attemptKey(target)} .selected=${target === selected}>
                ${target.label} · ${target.binding.sessionId.slice(0, 8)}
              </option>
            `,
          )}
        </select>
      </label>
      ${selected
        ? keyed(
            this.selected,
            html`<native-session-view .worker=${selected}></native-session-view>`,
          )
        : nothing}
    `;
  }
}
