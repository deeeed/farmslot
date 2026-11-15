// Read-only file and diff views on @pierre/diffs, the renderer T3 Code uses: highlighted with
// @pierre/highlights, line numbers, wrap, and a line reveal for file links. The library loads on
// first use, so pages without a native workspace never fetch it.
import type { File as PierreFile, FileDiff as PierreFileDiff } from '@pierre/diffs';
import { css, html, LitElement, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { CODE_THEME } from '../../utils/code-highlight.js';

const loadDiffs = () => import('@pierre/diffs');

const viewStyles = css`
  :host {
    display: block;
    min-height: 0;
    overflow: auto;
    font-size: 12px;
  }
  .empty {
    padding: 12px;
    opacity: 0.7;
  }
`;

/** The code text a view shows (line numbers included), for proofs and probes. */
function renderedText(host: LitElement): string {
  const container = host.renderRoot.querySelector('diffs-container');
  return container?.shadowRoot?.querySelector('pre')?.textContent ?? '';
}

/** A workspace file, highlighted, with `line` selected and scrolled into view when set. */
@customElement('pierre-file-view')
export class PierreFileView extends LitElement {
  static styles = viewStyles;
  @property() path = '';
  @property() content = '';
  /** 1-based line to reveal; 0 for none. */
  @property({ type: Number }) line = 0;
  private view?: PierreFile<undefined, undefined>;
  /** Bumped per render request, so a slow library load never draws a stale file. */
  private revision = 0;

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has('path') || changed.has('content') || changed.has('line')) void this.draw();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.revision++;
    this.view?.cleanUp();
    this.view = undefined;
  }

  private async draw() {
    const revision = ++this.revision;
    const { File } = await loadDiffs();
    if (revision !== this.revision || !this.isConnected) return;
    const wrapper = this.renderRoot.querySelector<HTMLElement>('.file');
    if (!wrapper) return;
    this.view ??= new File<undefined, undefined>({
      theme: CODE_THEME,
      themeType: 'dark',
      preferredHighlighter: 'highlights',
      overflow: 'wrap',
      disableFileHeader: true,
      onPostRender: (node) => this.reveal(node),
    });
    this.view.render({
      file: { name: this.path, contents: this.content },
      containerWrapper: wrapper,
    });
    this.view.setSelectedLines(this.line > 0 ? { start: this.line, end: this.line } : null);
  }

  /** Scrolls the revealed line to the middle of the view once its row exists. */
  private reveal(node: HTMLElement) {
    if (this.line <= 0) return;
    const row = (node.shadowRoot ?? node).querySelector(`[data-line="${this.line}"]`);
    row?.scrollIntoView({ block: 'center' });
  }

  get renderedText(): string {
    return renderedText(this);
  }

  render() {
    return html`<div class="file" data-testid="pierre-file" data-line=${this.line || ''}></div>`;
  }
}

/** One file's unified diff, parsed from a git patch. */
@customElement('pierre-diff-view')
export class PierreDiffView extends LitElement {
  static styles = viewStyles;
  @property() filename = '';
  @property() diff = '';
  @property() diffStyle: 'unified' | 'split' = 'unified';
  private view?: PierreFileDiff<undefined, undefined>;
  private revision = 0;
  private unparsed = false;

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has('diff') || changed.has('diffStyle') || changed.has('filename'))
      void this.draw();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.revision++;
    this.view?.cleanUp();
    this.view = undefined;
  }

  private async draw() {
    const revision = ++this.revision;
    const { FileDiff, parsePatchFiles } = await loadDiffs();
    if (revision !== this.revision || !this.isConnected) return;
    const wrapper = this.renderRoot.querySelector<HTMLElement>('.diff');
    if (!wrapper) return;
    const fileDiff = parsePatchFiles(this.diff, this.filename).flatMap((patch) => patch.files)[0];
    this.unparsed = !fileDiff;
    if (!fileDiff) {
      this.view?.cleanUp();
      this.view = undefined;
      this.requestUpdate();
      return;
    }
    this.view ??= new FileDiff<undefined, undefined>({
      theme: CODE_THEME,
      themeType: 'dark',
      preferredHighlighter: 'highlights',
      overflow: 'wrap',
      diffStyle: this.diffStyle,
    });
    this.view.setOptions({ ...this.view.options, diffStyle: this.diffStyle });
    this.view.render({ fileDiff, containerWrapper: wrapper });
  }

  get renderedText(): string {
    return renderedText(this);
  }

  render() {
    return html`<div class="diff" data-testid="pierre-diff"></div>
      ${this.unparsed
        ? html`<pre class="empty" data-testid="pierre-diff-raw">${this.diff}</pre>`
        : ''}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pierre-file-view': PierreFileView;
    'pierre-diff-view': PierreDiffView;
  }
}
