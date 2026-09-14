import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  Methods,
  type NativeProfileInfo,
  type NativeProfileListResult,
  type NativeProfileStatusResult,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import type { NativeSessionApi } from './native-workspace.js';

export interface NativeProfileSelection {
  profile?: NativeProfileInfo;
  ready: boolean;
  executionNodeId: string;
}

@customElement('native-profiles')
export class NativeProfiles extends LitElement {
  @property({ attribute: false }) api: NativeSessionApi = gateway;
  @property() executionNodeId = 'local';
  @property() runner = '';
  @property({ type: Boolean }) runnerOnly = false;
  @property({ type: Number }) refreshVersion = 0;
  @property({ type: Boolean }) disabled = false;
  @state() private profiles: NativeProfileInfo[] = [];
  @state() private selected = '';
  @state() private status?: NativeProfileStatusResult;
  @state() private name = '';
  @state() private directory = '';
  @state() private busy = false;
  @state() private mutating = false;
  @state() private error = '';
  private revision = 0;
  private selectedContextId = '';
  private selectionTimer?: ReturnType<typeof setTimeout>;

  static styles = css`
    :host {
      display: block;
      margin: 12px 0;
      font: inherit;
    }
    label {
      display: grid;
      gap: 6px;
      margin: 8px 0;
    }
    input,
    select,
    button {
      color: inherit;
      background: #171720;
      border: 1px solid #353545;
      border-radius: 4px;
      padding: 7px;
      font: inherit;
    }
    select,
    input {
      width: 100%;
      box-sizing: border-box;
    }
    button {
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .error {
      color: #ff9292;
    }
    p {
      font-size: 12px;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 11px;
    }
    details {
      margin-top: 8px;
    }
    summary {
      cursor: pointer;
    }
  `;

  protected updated(changed: Map<PropertyKey, unknown>) {
    if (
      changed.has('executionNodeId') ||
      changed.has('api') ||
      (this.runnerOnly && changed.has('runner'))
    ) {
      this.selected = '';
      this.selectedContextId = '';
      this.status = undefined;
      void this.refresh();
    } else if (changed.has('refreshVersion')) {
      void this.refresh();
    }
  }
  disconnectedCallback() {
    clearTimeout(this.selectionTimer);
    this.revision++;
    super.disconnectedCallback();
  }
  private selection(profile: NativeProfileInfo | undefined, ready: boolean) {
    this.dispatchEvent(
      new CustomEvent<NativeProfileSelection>('native-profile-change', {
        detail: { profile, ready, executionNodeId: this.executionNodeId },
        bubbles: true,
        composed: true,
      }),
    );
  }
  private async refresh() {
    clearTimeout(this.selectionTimer);
    const revision = ++this.revision;
    this.busy = true;
    this.error = '';
    this.selection(
      this.profiles.find((profile) => profile.id === this.selected),
      false,
    );
    try {
      const result = await this.api.request<NativeProfileListResult>(Methods.NATIVE_PROFILE_LIST, {
        executionNodeId: this.executionNodeId,
      });
      if (!this.isConnected || revision !== this.revision) return;
      this.profiles = this.runnerOnly
        ? result.profiles.filter((profile) => profile.runner === this.runner)
        : result.profiles;
      await this.choose(this.selected, this.selectedContextId);
    } catch (error) {
      if (revision === this.revision) this.error = (error as Error).message;
    } finally {
      if (revision === this.revision) this.busy = false;
    }
  }
  private chooseAfterNavigation(id: string) {
    clearTimeout(this.selectionTimer);
    this.revision++;
    this.selected = id;
    this.selectedContextId = '';
    this.status = undefined;
    this.selection(
      this.profiles.find((profile) => profile.id === id),
      !id,
    );
    if (!id) {
      void this.choose(id);
      return;
    }
    this.busy = true;
    this.selectionTimer = setTimeout(() => void this.choose(id), 150);
  }
  private async choose(id: string, expectedContextId = '') {
    const revision = ++this.revision;
    this.selected = id;
    this.status = undefined;
    this.error = '';
    const profile = this.profiles.find((item) => item.id === id);
    this.selection(profile, !id);
    if (!profile) {
      if (id)
        this.error = 'Profile is unavailable. Choose another profile or the node default account.';
      else this.selectedContextId = '';
      this.busy = false;
      return;
    }
    if (expectedContextId && profile.accountContextId !== expectedContextId) {
      this.error =
        'Profile registration changed. Review its directory before using the updated profile.';
      this.busy = false;
      return;
    }
    this.selectedContextId = profile.accountContextId;
    if (profile.state !== 'active') {
      this.error = 'Profile removal is incomplete. Stop its workers and retry removal.';
      this.busy = false;
      return;
    }
    this.busy = true;
    try {
      const status = await this.api.request<NativeProfileStatusResult>(
        Methods.NATIVE_PROFILE_STATUS,
        { executionNodeId: this.executionNodeId, profileId: id },
      );
      if (!this.isConnected || revision !== this.revision) return;
      if (
        status.profile.accountContextId !== profile.accountContextId ||
        status.profile.id !== profile.id ||
        status.profile.runner !== profile.runner ||
        status.profile.state !== 'active'
      )
        throw new Error('Profile changed. Refresh profiles and choose it again.');
      this.status = status;
      this.selection(profile, status.account.login === 'authenticated');
    } catch (error) {
      if (revision === this.revision) this.error = (error as Error).message;
    } finally {
      if (revision === this.revision) this.busy = false;
    }
  }
  private async add() {
    this.mutating = true;
    this.busy = true;
    this.error = '';
    this.selection(
      this.profiles.find((profile) => profile.id === this.selected),
      false,
    );
    const revision = ++this.revision;
    try {
      const result = await this.api.request<{ profile: NativeProfileInfo }>(
        Methods.NATIVE_PROFILE_ADD,
        {
          executionNodeId: this.executionNodeId,
          profileId: this.name.trim(),
          runner: this.runner,
          ...(this.directory.trim() ? { directory: this.directory.trim() } : {}),
        },
      );
      if (!this.isConnected || revision !== this.revision) return;
      this.selected = result.profile.id;
      this.selectedContextId = result.profile.accountContextId;
      this.name = '';
      this.directory = '';
      await this.refresh();
    } catch (error) {
      if (revision === this.revision) {
        await this.choose(this.selected, this.selectedContextId);
        this.error = (error as Error).message;
      }
    } finally {
      this.mutating = false;
      if (revision === this.revision) this.busy = false;
    }
  }
  private async removeProfile(profile: NativeProfileInfo) {
    this.mutating = true;
    this.busy = true;
    this.selection(profile, false);
    const revision = ++this.revision;
    try {
      await this.api.request(Methods.NATIVE_PROFILE_REMOVE, {
        executionNodeId: this.executionNodeId,
        profileId: profile.id,
        accountContextId: profile.accountContextId,
      });
      if (!this.isConnected || revision !== this.revision) return;
      this.selected = '';
      this.status = undefined;
      await this.refresh();
    } catch (error) {
      if (revision === this.revision) this.error = (error as Error).message;
    } finally {
      this.mutating = false;
      if (revision === this.revision) this.busy = false;
    }
  }
  render() {
    const profile = this.profiles.find((item) => item.id === this.selected);
    const disabled = this.disabled || this.busy;
    return html` <label
        >Account profile<select
          data-testid="native-profile"
          .value=${this.selected}
          ?disabled=${this.disabled || this.mutating}
          @change=${(event: Event) =>
            this.chooseAfterNavigation((event.target as HTMLSelectElement).value)}
        >
          <option value="" .selected=${!this.selected}>Node default account</option>
          ${this.selected && !profile
            ? html`<option value=${this.selected} .selected=${true} disabled>
                ${this.selected} · unavailable
              </option>`
            : nothing}
          ${this.profiles.map(
            (item) =>
              html`<option value=${item.id} .selected=${item.id === this.selected}>
                ${item.id} · ${item.runner}${item.state === 'retiring' ? ' · retiring' : ''}
              </option>`,
          )}
        </select></label
      >
      <div class="row">
        <button
          data-testid="native-profile-refresh"
          ?disabled=${disabled}
          @click=${() => void this.refresh()}
        >
          Refresh profiles
        </button>
        ${profile
          ? html`<button
              data-testid="native-profile-remove"
              ?disabled=${disabled}
              @click=${() => void this.removeProfile(profile)}
            >
              Remove profile and close its sessions
            </button>`
          : nothing}
      </div>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${profile && this.selectedContextId && profile.accountContextId !== this.selectedContextId
        ? html`<p>${profile.directory}</p>
            <button
              data-testid="native-profile-use-updated"
              ?disabled=${disabled}
              @click=${() => this.chooseAfterNavigation(profile.id)}
            >
              Use updated profile
            </button>`
        : nothing}
      ${this.status
        ? html`<p data-testid="native-profile-status">
              ${this.status.account.installed
                ? `${this.status.account.login} · ${this.status.account.mode}`
                : 'Native runner is not installed'}${this.status.account.identity?.email
                ? ` · ${this.status.account.identity.email}`
                : ''}
            </p>
            <details>
              <summary>Native login on ${this.executionNodeId}</summary>
              <p>
                Use this command on the selected node to sign in. Switching accounts in the same
                directory keeps this profile and its saved conversations. Refresh to check the
                current login.
              </p>
              <pre data-testid="native-profile-login-command">${this.status.loginCommand}</pre>
            </details>`
        : nothing}
      <details>
        <summary>Add a ${this.runner} profile</summary>
        <label
          >Profile name<input
            data-testid="native-profile-name"
            .value=${this.name}
            ?disabled=${disabled}
            @input=${(event: Event) => (this.name = (event.target as HTMLInputElement).value)}
            placeholder="work"
        /></label>
        <label
          >Existing native directory, optional<input
            data-testid="native-profile-directory"
            .value=${this.directory}
            ?disabled=${disabled}
            @input=${(event: Event) => (this.directory = (event.target as HTMLInputElement).value)}
        /></label>
        <button
          data-testid="native-profile-add"
          ?disabled=${disabled || !this.runner || !this.name.trim()}
          @click=${() => void this.add()}
        >
          Add profile
        </button>
      </details>`;
  }
}
