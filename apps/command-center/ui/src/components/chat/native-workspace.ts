import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  Methods,
  type NativeWorkerControlTarget,
  type NativeWorkspaceChangesResult,
  type NativeWorkspaceDiffResult,
  type NativeWorkspaceListResult,
  type NativeWorkspaceReadResult,
  viewChoiceField,
  viewTextField,
} from '@farmslot/protocol';

import '../diff-viewer/pierre-views.js';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';
import { onHighlighterReady } from '../../utils/code-highlight.js';
import { diffSelectionHandOff } from '../../utils/diff-test-filter.js';
import { renderChatMarkdown } from '../../utils/markdown.js';
import { viewBinding, ViewStateBindings } from '../../utils/view-state.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';
import { WorkspaceReads } from '../workspace/workspace-reads.js';

/** Commands a native view sends. Its reads come from the shared resource cache. */
export type NativeSessionCommand =
  | typeof Methods.NATIVE_SESSION_CREATE
  | typeof Methods.NATIVE_SESSION_SET_APPROVAL_MODE
  | typeof Methods.NATIVE_SESSION_SEND
  | typeof Methods.NATIVE_SESSION_RESPOND
  | typeof Methods.NATIVE_SESSION_INTERRUPT
  | typeof Methods.NATIVE_SESSION_CANCEL
  | typeof Methods.NATIVE_SESSION_TURN_DIFF
  | typeof Methods.NATIVE_SESSION_CLOSE
  | typeof Methods.NATIVE_PROFILE_ADD
  | typeof Methods.NATIVE_PROFILE_REMOVE;

export interface NativeSessionApi {
  request<T = unknown>(method: NativeSessionCommand, params?: unknown): Promise<T>;
}

/** Extensions T3 Code previews as rendered Markdown. */
const isMarkdownPath = (path: string) => /\.(?:md|mdx|markdown|mdown|mkd)$/i.test(path);

@customElement('native-workspace')
export class NativeWorkspace extends LitElement {
  @property() sessionId = '';
  @property() executionNodeId = 'local';
  @property({ attribute: false }) api: NativeSessionApi = gateway;
  @property({ attribute: false }) worker?: NativeWorkerControlTarget;
  @state() private tab: 'files' | 'changes' = 'changes';
  @state() private directory = '.';
  @state() private listing?: NativeWorkspaceListResult;
  @state() private changes?: NativeWorkspaceChangesResult;
  @state() private selected = '';
  @state() private source?: NativeWorkspaceReadResult;
  @state() private diff?: NativeWorkspaceDiffResult;
  @state() private display: 'source' | 'diff' = 'diff';
  /** Line a file link asked to reveal in the source view; 0 for none. */
  @state() private line = 0;
  /** A Markdown file shows rendered unless the reader chose its source. */
  @state() private markdownView: 'rendered' | 'raw' = 'rendered';
  @state() private error = '';
  @state() private loading = false;
  private revision = 0;
  private readonly reads: WorkspaceReads = new WorkspaceReads(
    this,
    () => {},
    undefined,
    () => {
      this.revision++;
      this.listing = undefined;
      this.changes = undefined;
      this.source = undefined;
      this.diff = undefined;
    },
  );
  // Native sessions carry no project, so the default test globs apply.
  private readonly testFilter = new DiffTestFilterController(this, {
    onChange: () => this.leaveHiddenFile(),
  });

  private readonly displayChoices = new ViewStateBindings(
    this,
    [
      viewBinding(
        viewChoiceField<'files' | 'changes'>('nativeFilesTab', 'changes', ['files', 'changes']),
        () => this.tab,
        (value) => {
          this.tab = value;
        },
      ),
      viewBinding(
        viewTextField('nativeDirectory', '.'),
        () => this.directory,
        (value) => {
          this.directory = value;
        },
      ),
      viewBinding(
        viewTextField('nativeFile'),
        () => this.selected,
        (value) => {
          this.selected = value;
        },
      ),
      viewBinding(
        viewChoiceField<'source' | 'diff'>('nativeFileView', 'diff', ['source', 'diff']),
        () => this.display,
        (value) => {
          this.display = value;
        },
      ),
      viewBinding(
        viewChoiceField<'rendered' | 'raw'>('nativeMarkdownView', 'rendered', ['rendered', 'raw']),
        () => this.markdownView,
        (value) => {
          this.markdownView = value;
        },
      ),
    ],
    () => {
      if (this.hasUpdated && this.sessionId) void this.refresh();
    },
  );

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
    button[aria-selected='true'],
    button[aria-pressed='true'] {
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
    .viewer pierre-file-view,
    .viewer pierre-diff-view,
    .viewer .markdown {
      flex: 1;
      min-height: 0;
    }
    .markdown {
      overflow: auto;
      padding: 8px 12px;
      font-family: system-ui, sans-serif;
      font-size: ${unsafeCSS(fonts.sizeMd)};
      line-height: 1.5;
    }
    .markdown a {
      color: ${unsafeCSS(colors.accent)};
    }
    .markdown code {
      font-family: ${unsafeCSS(fonts.mono)};
      background: ${unsafeCSS(colors.bgSidebar)};
      padding: 1px 4px;
      border-radius: 3px;
    }
    .markdown pre {
      background: ${unsafeCSS(colors.bgSidebar)};
      padding: 8px;
      border-radius: 4px;
      overflow: auto;
    }
    .markdown pre code {
      background: none;
      padding: 0;
    }
    .markdown .cm-code-head {
      display: none;
    }
    .markdown table {
      border-collapse: collapse;
    }
    .markdown th,
    .markdown td {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      padding: 2px 6px;
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
    if (
      changed.has('sessionId') ||
      changed.has('executionNodeId') ||
      (changed.has('worker') &&
        JSON.stringify(changed.get('worker')) !== JSON.stringify(this.worker))
    ) {
      this.revision++;
      this.reads.clear();
      this.displayChoices.restore();
      this.source = undefined;
      this.diff = undefined;
      this.listing = undefined;
      this.changes = undefined;
      if (this.sessionId) void this.refresh();
    }
  }

  private stopHighlightListener?: () => void;

  connectedCallback() {
    super.connectedCallback();
    // Rendered markdown shows a fence as plain text until its language loads, then highlighted.
    this.stopHighlightListener ??= onHighlighterReady(() => {
      if (this.markdownView === 'rendered' && isMarkdownPath(this.source?.path ?? ''))
        this.requestUpdate();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.revision++;
    this.stopHighlightListener?.();
    this.stopHighlightListener = undefined;
  }

  private async refresh() {
    this.reads.clear();
    const revision = ++this.revision;
    const sessionId = this.sessionId;
    const executionNodeId = this.executionNodeId;
    this.loading = true;
    this.error = '';
    try {
      if (this.tab === 'files') {
        const result = await this.reads.read<NativeWorkspaceListResult>(
          Methods.NATIVE_SESSION_WORKSPACE_LIST,
          {
            sessionId,
            executionNodeId,
            path: this.directory,
            ...(this.worker ? { worker: this.worker } : {}),
          },
          (result) => {
            this.listing = result;
            this.error = '';
          },
        );
        if (revision !== this.revision) return;
        this.listing = result;
        this.error = '';
      } else {
        const result = await this.reads.read<NativeWorkspaceChangesResult>(
          Methods.NATIVE_SESSION_WORKSPACE_CHANGES,
          { sessionId, executionNodeId, ...(this.worker ? { worker: this.worker } : {}) },
          (result) => {
            this.changes = result;
            this.error = '';
          },
        );
        if (revision !== this.revision) return;
        this.changes = result;
        this.error = '';
      }
      if (this.selected)
        await this.openFile(this.selected, this.display, sessionId, executionNodeId);
    } catch (error) {
      if (revision === this.revision) this.error = (error as Error).message;
    } finally {
      if (revision === this.revision) this.loading = false;
    }
  }

  /**
   * Opens `path` (relative to the workspace) in the Files tab at `line`, as a file link in the
   * conversation asks. Its directory is listed so the file shows selected in the list.
   */
  async openPath(path: string, line = 0) {
    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    if (this.tab !== 'files' || this.directory !== directory) {
      this.reads.clear();
      this.tab = 'files';
      this.directory = directory;
      this.selected = '';
      this.source = undefined;
      this.diff = undefined;
      await this.refresh();
    }
    await this.openFile(path, 'source', this.sessionId, this.executionNodeId, line);
  }

  private async openFile(
    path: string,
    display: 'source' | 'diff',
    sessionId = this.sessionId,
    executionNodeId = this.executionNodeId,
    line = 0,
  ) {
    const revision = ++this.revision;
    this.line = line;
    this.reads.releaseMethods([
      Methods.NATIVE_SESSION_WORKSPACE_READ,
      Methods.NATIVE_SESSION_WORKSPACE_DIFF,
    ]);
    this.selected = path;
    this.display = display;
    this.source = undefined;
    this.diff = undefined;
    this.error = '';
    this.loading = true;
    try {
      if (display === 'source') {
        const result = await this.reads.read<NativeWorkspaceReadResult>(
          Methods.NATIVE_SESSION_WORKSPACE_READ,
          { sessionId, executionNodeId, path, ...(this.worker ? { worker: this.worker } : {}) },
          (result) => {
            if (revision === this.revision) {
              this.source = result;
              this.error = '';
            }
          },
        );
        if (revision === this.revision) {
          this.source = result;
          this.error = '';
        }
      } else {
        const result = await this.reads.read<NativeWorkspaceDiffResult>(
          Methods.NATIVE_SESSION_WORKSPACE_DIFF,
          { sessionId, executionNodeId, path, ...(this.worker ? { worker: this.worker } : {}) },
          (result) => {
            if (revision === this.revision) {
              this.diff = result;
              this.error = '';
            }
          },
        );
        if (revision === this.revision) {
          this.diff = result;
          this.error = '';
        }
      }
    } catch (error) {
      if (revision === this.revision) this.error = (error as Error).message;
    } finally {
      if (revision === this.revision) this.loading = false;
    }
  }

  /** Status rows carry no line counts; the split only needs paths. */
  private changeSplit() {
    const files = (this.changes?.files ?? []).map((file) => ({
      ...file,
      additions: 0,
      deletions: 0,
    }));
    return this.testFilter.split(files);
  }

  /**
   * A newly hidden selected change hands the viewer to the first listed change;
   * with nothing listed the selection goes, and so does any request in flight.
   */
  private leaveHiddenFile() {
    if (this.tab !== 'changes' || !this.selected || !this.testFilter.hides(this.selected)) return;
    const handOff = diffSelectionHandOff(
      this.changeSplit().visible,
      this.selected,
      Boolean(this.diff || this.source) || this.loading,
    );
    if (handOff.kind === 'select') {
      void this.openFile(handOff.path, 'diff');
    } else if (handOff.kind === 'clear') {
      this.revision++;
      this.selected = '';
      this.source = undefined;
      this.diff = undefined;
      this.loading = false;
    }
  }

  /**
   * Changes mode filters its list; a Files-mode diff carries the toggle itself.
   * A hidden test file's diff never renders, whichever way it arrived.
   */
  private renderDiff(diff: NativeWorkspaceDiffResult) {
    const review = () =>
      html`<pierre-diff-view .filename=${diff.path} .diff=${diff.diff}></pierre-diff-view>`;
    return this.tab === 'files' || this.testFilter.hides(diff.path)
      ? this.testFilter.renderFileDiff(diff.path, review)
      : review();
  }

  private switchTab(tab: 'files' | 'changes') {
    this.reads.clear();
    this.tab = tab;
    this.selected = '';
    this.source = undefined;
    this.diff = undefined;
    void this.refresh();
  }

  render() {
    const changeSplit = this.changeSplit();
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
        ${this.reads.error
          ? html`<button data-testid="workspace-retry" @click=${() => this.reads.retry()}>
              Retry
            </button>`
          : nothing}
        ${this.tab === 'changes' ? this.testFilter.renderControls(changeSplit.summary) : nothing}
      </header>
      <p class="scope">
        ${this.tab === 'changes'
          ? 'Current workspace compared with HEAD, including staged and untracked files. Changes may come from any writer.'
          : 'Read-only current workspace files.'}
      </p>
      ${this.reads.status ? html`<p class="scope" role="status">${this.reads.status}</p>` : nothing}
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
            : html`${changeSplit.visible.map(
                (entry) =>
                  html`<button
                    data-path=${entry.path}
                    @click=${() => this.openFile(entry.path, 'diff')}
                  >
                    ${entry.status} ${entry.path}
                  </button>`,
              )}
              ${this.changes?.files.length === 0
                ? html`<p class="empty">
                    ${this.changes.repository === false
                      ? 'Not a git repository: no file changes to show.'
                      : 'No workspace changes.'}
                  </p>`
                : changeSplit.hiddenCount > 0 && changeSplit.visible.length === 0
                  ? html`<p class="empty">Only test files changed (hidden).</p>`
                  : nothing}
              ${this.changes?.truncated
                ? html`<p class="scope">
                    First ${this.changes.files.length} changed files shown. Use Files to inspect
                    other paths.
                  </p>`
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
            ? this.renderSource(this.source)
            : this.diff
              ? this.diff.diff
                ? this.renderDiff(this.diff)
                : html`<p class="empty">No changes against HEAD for this file.</p>`
              : html`<p class="empty">
                  ${this.loading ? 'Loading workspace…' : 'Select a file to inspect.'}
                </p>`}
        </section>
      </div>`;
  }

  /** A Markdown file shows rendered (or its source, by choice); any other file, highlighted. */
  private renderSource(source: NativeWorkspaceReadResult) {
    if (!isMarkdownPath(source.path) || this.line > 0)
      return html`<pierre-file-view
        .path=${source.path}
        .content=${source.content}
        .line=${this.line}
      ></pierre-file-view>`;
    return html`<header>
        <button
          aria-pressed=${this.markdownView === 'rendered'}
          data-testid="workspace-markdown-rendered"
          @click=${() => {
            this.markdownView = 'rendered';
          }}
        >
          Rendered
        </button>
        <button
          aria-pressed=${this.markdownView === 'raw'}
          data-testid="workspace-markdown-raw"
          @click=${() => {
            this.markdownView = 'raw';
          }}
        >
          Raw
        </button>
      </header>
      ${this.markdownView === 'rendered'
        ? html`<div
            class="markdown"
            data-testid="workspace-markdown"
            .innerHTML=${renderChatMarkdown(source.content)}
          ></div>`
        : html`<pierre-file-view
            .path=${source.path}
            .content=${source.content}
          ></pierre-file-view>`}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'native-workspace': NativeWorkspace;
  }
}
