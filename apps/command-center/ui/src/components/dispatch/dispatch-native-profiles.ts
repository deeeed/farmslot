import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';

import type { NativeProfileReference, NativeSessionCatalogResult } from '@farmslot/protocol';

import '../chat/native-profiles.js';

import type { NativeProfileSelection } from '../chat/native-profiles.js';

import {
  dispatchNativeProfileKey,
  type DispatchNativeProfileSelection,
  nativeContextNode,
} from './dispatch-native-profile-model.js';

/** Reuses native configuration management; dispatch only adds node/slot affinity. */
@customElement('dispatch-native-profiles')
export class DispatchNativeProfiles extends LitElement {
  @property({ attribute: false }) catalog?: NativeSessionCatalogResult;
  @property() slotId = '';
  @property() project = '';
  @property() runner = '';
  @property({ type: Number }) refreshVersion = 0;
  @property({ type: Boolean }) disabled = false;
  @state() private chosenNode = '';
  private profile?: NativeProfileReference;
  private ready = false;
  private pickerKey = '';

  static styles = css`
    :host {
      display: block;
      margin: 10px 0;
      font: inherit;
    }
    label {
      display: grid;
      gap: 6px;
    }
    select {
      color: inherit;
      background: #171720;
      border: 1px solid #353545;
      border-radius: 4px;
      padding: 7px;
      font: inherit;
    }
    p {
      font-size: 12px;
    }
  `;

  private slotContext() {
    return this.catalog?.contexts.find((context) => context.slotId === this.slotId);
  }
  private node() {
    const context = this.slotContext();
    return this.slotId ? (context ? nativeContextNode(context) : '') : this.chosenNode;
  }
  private supportsProfiles() {
    if (this.slotId) return this.slotContext()?.supportsProfiles === true;
    return (
      this.catalog?.contexts.some(
        (context) => nativeContextNode(context) === this.node() && context.supportsProfiles,
      ) === true
    );
  }
  private publish() {
    this.dispatchEvent(
      new CustomEvent<DispatchNativeProfileSelection>('dispatch-native-profile-change', {
        detail: {
          key: dispatchNativeProfileKey(this),
          executionNodeId: this.node() || undefined,
          profile: this.profile,
          ready: this.ready && !this.disabled,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }
  protected updated(changed: Map<PropertyKey, unknown>) {
    const key = JSON.stringify([this.node(), this.runner]);
    if (key !== this.pickerKey) {
      this.pickerKey = key;
      const explicitChange =
        changed.has('runner') || changed.has('slotId') || changed.has('chosenNode');
      if (explicitChange || !this.profile) {
        this.profile = undefined;
        this.ready = !this.supportsProfiles();
      } else {
        // Catalog loss must not silently turn an explicit profile into a default-account run.
        this.ready = false;
      }
    }
    if (changed.has('refreshVersion') && this.supportsProfiles()) this.ready = false;
    if (this.profile && !this.supportsProfiles()) this.ready = false;
    this.publish();
  }
  render() {
    const node = this.node();
    const nodes = [
      ...new Set(
        (this.catalog?.contexts ?? [])
          .filter((context) => context.supportsProfiles)
          .map(nativeContextNode),
      ),
    ];
    const supports = this.supportsProfiles();
    return html`
      <label
        >Worker node
        <select
          data-testid="dispatch-native-node"
          .value=${node}
          ?disabled=${this.disabled || !!this.slotId}
          @change=${(event: Event) => {
            this.chosenNode = (event.target as HTMLSelectElement).value;
            this.profile = undefined;
            this.ready = !this.chosenNode;
            this.publish();
          }}
        >
          <option value="" .selected=${!node}>Any eligible node · default account</option>
          ${node && !nodes.includes(node)
            ? html`<option value=${node} selected>${node} · profiles unavailable</option>`
            : nothing}
          ${nodes.map((id) => html`<option value=${id} .selected=${id === node}>${id}</option>`)}
        </select>
      </label>
      ${this.slotId
        ? html`<p>
            The selected slot sets the worker node. Choose automatic slot selection to use another
            node.
          </p>`
        : node
          ? html`<p>Automatic selection uses eligible slots on ${node}.</p>`
          : nothing}
      ${this.profile && !supports
        ? html`<p role="alert">
            The selected profile is unavailable. Reconnect or choose another worker node.
          </p>`
        : nothing}
      ${supports
        ? keyed(
            JSON.stringify([node, this.runner]),
            html`<native-profiles
              .executionNodeId=${node}
              .runner=${this.runner}
              .runnerOnly=${true}
              .refreshVersion=${this.refreshVersion}
              .disabled=${this.disabled}
              @native-profile-change=${(event: CustomEvent<NativeProfileSelection>) => {
                const selected = event.detail;
                if (
                  selected.executionNodeId !== this.node() ||
                  (selected.profile && selected.profile.runner !== this.runner)
                )
                  return;
                if (selected.profile)
                  this.profile = {
                    executionNodeId: selected.executionNodeId,
                    runner: selected.profile.runner,
                    profileId: selected.profile.id,
                    accountContextId: selected.profile.accountContextId,
                  };
                else if (selected.ready) this.profile = undefined;
                this.ready = selected.ready;
                this.publish();
              }}
            ></native-profiles>`,
          )
        : node
          ? html`<p>
              Named profiles are unavailable on this node. Its default account remains available.
            </p>`
          : nothing}
    `;
  }
}
