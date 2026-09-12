import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  Methods,
  type NativeWorkspaceChangesResult,
  type NativeWorkspaceDiffResult,
  type NativeWorkspaceListResult,
  type NativeWorkspaceReadResult,
} from '@farmslot/protocol';

import '../diff-viewer/code-viewer.js';
import '../diff-viewer/diff-review.js';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

export interface NativeSessionApi {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

@customElement('native-workspace')
export class NativeWorkspace extends LitElement {
  @property() sessionId = '';
  @property({ attribute: false }) api: NativeSessionApi = gateway;
  @state() private tab: 'files' | 'changes' = 'changes';
  @state() private directory = '.';
  @state() private listing?: NativeWorkspaceListResult;
  @state() private changes?: NativeWorkspaceChangesResult;
  @state() private selected = '';
  @state() private source?: NativeWorkspaceReadResult;
  @state() private diff?: NativeWorkspaceDiffResult;
  @state() private display: 'source' | 'diff' = 'diff';
  @state() private error = '';
  @state() private loading = false;
  private revision = 0;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      height: 100%;
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
    }
    button {
      font: inherit;
      color: inherit;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 4px;
      background: ${unsafeCSS(colors.bgCard)};
      padding: 5px 9px;
      cursor: pointer;
    }
    button:focus-visible {
      outline: 2px solid ${unsafeCSS(colors.accent)};
    }
    button[aria-selected='true'] {
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.accent)};
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: ${unsafeCSS(spacing.sm)};
    }
    .scope {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      margin: 0 8px 8px;
    }
    .body {
      display: grid;
      grid-template-rows: minmax(0, 1fr);
      grid-template-columns: minmax(140px, 28%) minmax(0, 1fr);
      flex: 1;
      min-height: 0;
    }
    nav {
      overflow: auto;
      border-right: 1px solid ${unsafeCSS(colors.bgCardHover)};
      padding: 4px;
    }
    nav button {
      display: block;
      width: 100%;
      text-align: left;
      overflow-wrap: anywhere;
      margin-bottom: 4px;
      background: transparent;
    }
    .viewer {
      min-height: 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .viewer code-viewer,
    .viewer diff-review {
      flex: 1;
      min-height: 0;
    }
    .error {
      color: ${unsafeCSS(colors.statusFail)};
      padding: 8px;
      overflow-wrap: anywhere;
    }
    .empty {
      padding: 12px;
      color: ${unsafeCSS(colors.textMuted)};
    }
    @media (max-width: 700px) {
      .body {
        grid-template-columns: minmax(100px, 30%) minmax(0, 1fr);
      }
    }
  `;

  protected updated(changed: Map<string, unknown>) {
    if (changed.has('sessionId')) {
      this.revision++;
      this.directory = '.';
      this.selected = '';
      this.source = undefined;
      this.diff = undefined;
      this.listing = undefined;
      this.changes = undefined;
      if (this.sessionId) void this.refresh();
    }
  }

  private async refresh() {
    const revision = ++this.revision;
    const sessionId = this.sessionId;
    this.loading = true;
    this.error = '';
    try {
      if (this.tab === 'files') {
        const result = await this.api.request<NativeWorkspaceListResult>(
          Methods.NATIVE_SESSION_WORKSPACE_LIST,
          { sessionId, path: this.directory },
        );
        if (revision !== this.revision) return;
        this.listing = result;
      } else {
        const result = await this.api.request<NativeWorkspaceChangesResult>(
          Methods.NATIVE_SESSION_WORKSPACE_CHANGES,
          { sessionId },
        );
        if (revision !== this.revision) return;
        this.changes = result;
      }
      if (this.selected) await this.openFile(this.selected, this.display);
    } catch (error) {
      if (revision === this.revision) this.error = (error as Error).message;
    } finally {
      if (revision === this.revision) this.loading = false;
    }
  }

  private async openFile(path: string, display: 'source' | 'diff') {
    const revision = ++this.revision;
    this.selected = path;
    this.display = display;
    this.source = undefined;
    this.diff = undefined;
    this.error = '';
    this.loading = true;
    try {
      if (display === 'source') {
        const result = await this.api.request<NativeWorkspaceReadResult>(
          Methods.NATIVE_SESSION_WORKSPACE_READ,
          { sessionId: this.sessionId, path },
        );
        if (revision === this.revision) this.source = result;
      } else {
        const result = await this.api.request<NativeWorkspaceDiffResult>(
          Methods.NATIVE_SESSION_WORKSPACE_DIFF,
          { sessionId: this.sessionId, path },
        );
        if (revision === this.revision) this.diff = result;
      }
    } catch (error) {
      if (revision === this.revision) this.error = (error as Error).message;
    } finally {
      if (revision === this.revision) this.loading = false;
    }
  }

  private switchTab(tab: 'files' | 'changes') {
    this.tab = tab;
    this.selected = '';
    this.source = undefined;
    this.diff = undefined;
    void this.refresh();
  }

  render() {
    return html` <header>
        <span>Workspace</span>
        <div role="tablist" aria-label="Workspace views">
          <button
            role="tab"
            aria-selected=${this.tab === 'changes'}
            @click=${() => this.switchTab('changes')}
          >
            Changes
          </button>
          <button
            role="tab"
            aria-selected=${this.tab === 'files'}
            @click=${() => this.switchTab('files')}
          >
            Files
          </button>
        </div>
        <button data-testid="workspace-refresh" ?disabled=${this.loading} @click=${this.refresh}>
          Refresh
        </button>
      </header>
      <p class="scope">
        ${this.tab === 'changes'
          ? 'Current workspace compared with HEAD, including staged and untracked files. Changes may come from any writer.'
          : 'Read-only current workspace files.'}
      </p>
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      <div class="body">
        <nav aria-label=${this.tab === 'files' ? 'Workspace files' : 'Changed files'}>
          ${this.tab === 'files'
            ? html`
                ${this.directory !== '.'
                  ? html`<button
                      @click=${() => {
                        this.directory = this.directory.split('/').slice(0, -1).join('/') || '.';
                        this.selected = '';
                        this.source = undefined;
                        this.diff = undefined;
                        void this.refresh();
                      }}
                    >
                      Parent directory
                    </button>`
                  : nothing}
                ${(this.listing?.entries ?? []).map(
                  (entry) =>
                    html`<button
                      data-path=${entry.path}
                      @click=${() => {
                        if (entry.directory) {
                          this.directory = entry.path;
                          this.selected = '';
                          this.source = undefined;
                          this.diff = undefined;
                          void this.refresh();
                        } else void this.openFile(entry.path, 'source');
                      }}
                    >
                      ${entry.name}${entry.directory ? '/' : ''}
                    </button>`,
                )}
                ${this.listing?.truncated
                  ? html`<p class="scope">First 500 entries shown.</p>`
                  : nothing}
              `
            : html`${(this.changes?.files ?? []).map(
                (entry) =>
                  html`<button
                    data-path=${entry.path}
                    @click=${() => this.openFile(entry.path, 'diff')}
                  >
                    ${entry.status} ${entry.path}
                  </button>`,
              )}
              ${this.changes?.files.length === 0
                ? html`<p class="empty">No workspace changes.</p>`
                : nothing}`}
        </nav>
        <section class="viewer" aria-label="File preview">
          ${this.selected
            ? html`<header>
                <button
                  aria-pressed=${this.display === 'source'}
                  data-testid="workspace-source"
                  @click=${() => this.openFile(this.selected, 'source')}
                >
                  Source
                </button>
                <button
                  aria-pressed=${this.display === 'diff'}
                  data-testid="workspace-diff"
                  @click=${() => this.openFile(this.selected, 'diff')}
                >
                  Diff
                </button>
              </header>`
            : nothing}
          ${this.source
            ? html`<code-viewer
                .readOnly=${true}
                .filename=${this.source.path}
                .content=${this.source.content}
                .language=${this.language(this.source.path)}
              ></code-viewer>`
            : this.diff
              ? html`<diff-review
                  .filename=${this.diff.path}
                  .diff=${this.diff.diff}
                ></diff-review>`
              : html`<p class="empty">
                  ${this.loading ? 'Loading workspace…' : 'Select a file to inspect.'}
                </p>`}
        </section>
      </div>`;
  }

  private language(path: string): string {
    const extension = path.split('.').at(-1) ?? '';
    return (
      (
        {
          ts: 'typescript',
          tsx: 'typescript',
          js: 'javascript',
          jsx: 'javascript',
          json: 'json',
          md: 'markdown',
          py: 'python',
          sh: 'shell',
          css: 'css',
          html: 'html',
          yml: 'yaml',
          yaml: 'yaml',
          rs: 'rust',
          go: 'go',
        } as Record<string, string>
      )[extension] ?? 'plaintext'
    );
  }
}
