import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';

import type { AgentContext } from '@farmslot/protocol';

import '../chat/native-session-view.js';

import {
  nativeWorkerAttemptKey,
  nativeWorkerTargets,
  selectedNativeWorkerTarget,
} from '../chat/native-worker-target.js';

@customElement('native-worker-history')
export class NativeWorkerHistory extends LitElement {
  @property({ attribute: false }) contexts: AgentContext[] = [];
  @property({ type: Boolean }) expanded = true;
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
    if (!this.expanded) return nothing;
    const attempts = nativeWorkerTargets(this.contexts);
    if (!attempts.length) return nothing;
    const selected = selectedNativeWorkerTarget(attempts, this.selected);
    const selectedKey = selected ? nativeWorkerAttemptKey(selected) : '';
    return html`
      <label
        >Worker conversations
        <select
          data-testid="native-worker-history-select"
          .value=${selectedKey}
          @change=${(event: Event) => {
            this.selected = (event.target as HTMLSelectElement).value;
          }}
        >
          <option value="" .selected=${!selected}>Choose task history</option>
          ${attempts.map(
            (target) => html`
              <option value=${nativeWorkerAttemptKey(target)} .selected=${target === selected}>
                ${target.label} · ${target.binding.sessionId.slice(0, 8)}
              </option>
            `,
          )}
        </select>
      </label>
      ${selected
        ? keyed(selectedKey, html`<native-session-view .worker=${selected}></native-session-view>`)
        : nothing}
    `;
  }
}
