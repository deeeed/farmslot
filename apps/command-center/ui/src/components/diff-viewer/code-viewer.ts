import DOMPurify from 'dompurify';
import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { marked } from 'marked';
import type * as monaco from 'monaco-editor';

import type { Diagnostic, PRReviewThread } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { adoptDocumentCss } from '../../utils/shadow-css.js';

marked.setOptions({ breaks: true, gfm: true });

// Monaco is multi-MB of JS. Loading it eagerly forces every page reload to
// re-parse it on the main thread, which compounds with HMR full-reload bursts
// from background agents and trips Chrome's "Page Unresponsive" watchdog.
// We load it lazily on first `firstUpdated()` so reloads that don't show a
// code-viewer never touch Monaco at all.
type MonacoApi = typeof monaco;
type TsContribution = typeof import('monaco-editor/esm/vs/language/typescript/monaco.contribution');
let monacoApi: MonacoApi | null = null;
let tsContribution: TsContribution | null = null;
let monacoLoadPromise: Promise<MonacoApi> | null = null;

function loadMonaco(): Promise<MonacoApi> {
  if (monacoApi) return Promise.resolve(monacoApi);
  if (monacoLoadPromise) return monacoLoadPromise;

  // MonacoEnvironment must be set before Monaco asks for workers. Setting it
  // synchronously inside this function is safe — workers are spawned on first
  // editor use, which happens after the dynamic import resolves.
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      switch (label) {
        case 'typescript':
        case 'javascript':
          // @ts-ignore — Vite handles Worker URL resolution at bundle time
          return new Worker(
            new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url),
            { type: 'module' },
          );
        case 'json':
          // @ts-ignore — Vite handles Worker URL resolution at bundle time
          return new Worker(
            new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
            { type: 'module' },
          );
        case 'css':
        case 'scss':
        case 'less':
          // @ts-ignore — Vite handles Worker URL resolution at bundle time
          return new Worker(
            new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url),
            { type: 'module' },
          );
        default:
          // @ts-ignore — Vite handles Worker URL resolution at bundle time
          return new Worker(
            new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
            { type: 'module' },
          );
      }
    },
  };

  monacoLoadPromise = (async () => {
    // Side-effect imports: base CSS + TS language contribution. The TS module
    // also exposes the diagnostic-option `*Defaults` we need at theme time.
    // @ts-ignore — CSS module type
    await import('monaco-editor/min/vs/editor/editor.main.css');
    tsContribution = await import('monaco-editor/esm/vs/language/typescript/monaco.contribution');
    const ns = await import('monaco-editor');
    monacoApi = ns;
    return ns;
  })();
  return monacoLoadPromise;
}

/** Resolve a relative import path against a directory */
function resolveRelativePath(dir: string, importPath: string): string {
  const parts = dir ? dir.split('/') : [];
  for (const seg of importPath.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

const THEME_ID = 'farmslot-dark';
let themeRegistered = false;
let openerRegistered = false;
let linkProviderRegistered = false;
let activeCodeViewer: CodeViewer | null = null;

const IMPORT_PATTERN = /(?:from\s+|require\s*\(\s*)(['"])([^'"]+)\1/g;

function registerImportLinkProvider() {
  if (linkProviderRegistered) return;
  linkProviderRegistered = true;
  const m = monacoApi!;

  // Register for all languages we might open
  for (const lang of ['typescript', 'javascript', 'typescriptreact', 'javascriptreact']) {
    m.languages.registerLinkProvider(lang, {
      provideLinks(model) {
        const links: monaco.languages.ILink[] = [];
        for (let i = 1; i <= model.getLineCount(); i++) {
          const line = model.getLineContent(i);
          IMPORT_PATTERN.lastIndex = 0;
          let match;
          while ((match = IMPORT_PATTERN.exec(line)) !== null) {
            const importPath = match[2];
            if (!importPath.startsWith('.')) continue;
            // Find the position of the path string (after the quote)
            const pathStart = match.index + match[0].indexOf(importPath);
            links.push({
              range: new m.Range(i, pathStart + 1, i, pathStart + importPath.length + 1),
              // Encode the import path in the URI — the opener will resolve it
              url: m.Uri.parse(`farmslot-import:///${importPath}`),
              tooltip: `Open ${importPath}`,
            });
          }
        }
        return { links };
      },
    });
  }
}

function registerEditorOpener(viewer: CodeViewer) {
  activeCodeViewer = viewer;
  if (openerRegistered) return;
  openerRegistered = true;
  monacoApi!.editor.registerEditorOpener({
    openCodeEditor: (_source, resource, selectionOrPosition) => {
      if (!activeCodeViewer) return false;

      // Handle import path links (farmslot-import:///../../path)
      if (resource.scheme === 'farmslot-import') {
        const importPath = resource.path.replace(/^\//, '');
        const currentDir = activeCodeViewer.filePath.includes('/')
          ? activeCodeViewer.filePath.substring(0, activeCodeViewer.filePath.lastIndexOf('/'))
          : '';
        const resolved = resolveRelativePath(currentDir, importPath);
        activeCodeViewer.dispatchEvent(
          new CustomEvent('open-file', {
            detail: { path: resolved, line: 1 },
            bubbles: true,
            composed: true,
          }),
        );
        return true;
      }

      // Skip inmemory models (Monaco internal)
      if (resource.scheme === 'inmemory') return false;

      // For file:/// URIs — cross-file Go to Definition
      const targetPath = resource.path.replace(/^\//, '');
      if (targetPath === activeCodeViewer.filePath) return false;

      const line =
        selectionOrPosition && 'startLineNumber' in selectionOrPosition
          ? selectionOrPosition.startLineNumber
          : selectionOrPosition && 'lineNumber' in selectionOrPosition
            ? selectionOrPosition.lineNumber
            : 1;
      activeCodeViewer.dispatchEvent(
        new CustomEvent('open-file', {
          detail: { path: targetPath, line },
          bubbles: true,
          composed: true,
        }),
      );
      return true;
    },
  });
}

function ensureTheme() {
  if (themeRegistered) return;
  const m = monacoApi!;
  const tsc = tsContribution!;

  // Disable built-in TypeScript diagnostics — Monaco doesn't have the project's
  // tsconfig/node_modules, so every import shows false squiggly errors.
  // Real diagnostics come from the Problems panel (tsc --noEmit via gateway).
  tsc.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  tsc.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });

  m.editor.defineTheme(THEME_ID, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#12121a',
      'editor.foreground': '#e0e0e8',
      'editorLineNumber.foreground': '#6b6b8a',
      'editorLineNumber.activeForeground': '#a0a0c0',
      'editorGutter.background': '#0f0f18',
    },
  });
  themeRegistered = true;
}

@customElement('code-viewer')
export class CodeViewer extends LitElement {
  @property() content = '';
  @property() language = 'typescript';
  @property() filename = '';
  @property({ type: Boolean }) readOnly = false;
  @property({ type: Array }) changedLines: number[] = [];
  @property({ type: Array }) commentThreads: PRReviewThread[] = [];
  @property({ type: Boolean }) showComments = true;
  @property({ type: Number }) revealLine = 0;
  /** Full repo-relative path for this file (used for model URI + cross-file nav) */
  @property() filePath = '';
  @property({ attribute: false }) diagnostics: Diagnostic[] = [];

  private _editor?: monaco.editor.IStandaloneCodeEditor;
  private _resizeObserver?: ResizeObserver;
  private _decorations: monaco.editor.IEditorDecorationsCollection | undefined;
  private _commentDecorations: monaco.editor.IEditorDecorationsCollection | undefined;
  private _viewZoneIds: string[] = [];
  private _viewZoneDomNodes: HTMLElement[] = [];
  private _collapsedThreadIds = new Set<string>(); // collapsed by default = false, tracks manually collapsed ones
  private _layoutDisposable?: monaco.IDisposable;

  protected override createRenderRoot() {
    return this;
  }

  override async firstUpdated() {
    await loadMonaco();
    ensureTheme();
    adoptDocumentCss(
      this,
      (href, text) => href.includes('monaco') || text.includes('.monaco-editor'),
      'monaco',
    );
    // Defer so the DOM has resolved layout dimensions
    requestAnimationFrame(() => this._initEditor());
  }

  private _initEditor() {
    const container = this.querySelector('.cv-editor') as HTMLElement;
    if (!container) return;
    const m = monacoApi!;

    const modelUri = m.Uri.parse(`file:///${this.filePath || this.filename || 'untitled'}`);
    const model = m.editor.createModel(this.content, this.language, modelUri);

    this._editor = m.editor.create(container, {
      model,
      theme: THEME_ID,
      readOnly: this.readOnly,
      automaticLayout: true,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      fontSize: 13,
      fontFamily: fonts.mono,
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      glyphMargin: true,
      renderLineHighlight: 'gutter',
      guides: { indentation: false },
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
    });

    this._applyDecorations();
    this._applyCommentDecorations();

    // Intercept "Go to Definition" / "Open Editor" — route to our file opening logic
    registerEditorOpener(this);

    // Register link provider so import paths show as clickable (underline on Cmd+hover)
    registerImportLinkProvider();

    // Glyph margin click → emit event for new comment creation
    this._editor.onMouseDown((e) => {
      if (e.target.type === m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        const line = e.target.position?.lineNumber;
        if (line) {
          this.dispatchEvent(
            new CustomEvent('glyph-click', {
              detail: { line },
              bubbles: true,
              composed: true,
            }),
          );
        }
      }
    });

    // Update widget widths when editor layout changes
    this._layoutDisposable = this._editor.onDidLayoutChange(() => this._updateWidgetWidths());

    this._resizeObserver = new ResizeObserver(() => {
      this._editor?.layout();
    });
    this._resizeObserver.observe(container);
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has('content') || changed.has('language') || changed.has('filePath')) {
      if (this._editor && monacoApi) {
        const m = monacoApi;
        this._editor.getModel()?.dispose();
        const uri = m.Uri.parse(`file:///${this.filePath || this.filename || 'untitled'}`);
        this._editor.setModel(m.editor.createModel(this.content, this.language, uri));
        this._applyDecorations();
        this._applyCommentDecorations();
        this._applyCommentZones();
        // Re-apply reveal after model change
        if (this.revealLine > 0) {
          this._editor.revealLineInCenter(this.revealLine);
          this._editor.setPosition({ lineNumber: this.revealLine, column: 1 });
        }
      }
    }
    if (changed.has('changedLines')) {
      this._applyDecorations();
    }
    if (changed.has('commentThreads') || changed.has('showComments')) {
      this._applyCommentDecorations();
      this._applyCommentZones();
    }
    if (changed.has('revealLine') && this.revealLine > 0 && this._editor) {
      this._editor.revealLineInCenter(this.revealLine);
      this._editor.setPosition({ lineNumber: this.revealLine, column: 1 });
    }
    if (changed.has('readOnly') && this._editor) {
      this._editor.updateOptions({ readOnly: this.readOnly });
    }
    if (changed.has('diagnostics') || changed.has('filePath') || changed.has('content')) {
      this._applyDiagnosticMarkers();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
    this._layoutDisposable?.dispose();
    // Clean up view zones before disposing
    if (this._editor && this._viewZoneIds.length > 0) {
      this._editor.changeViewZones((accessor) => {
        for (const id of this._viewZoneIds) accessor.removeZone(id);
      });
    }
    this._viewZoneIds = [];
    this._viewZoneDomNodes = [];
    this._editor?.getModel()?.dispose();
    this._editor?.dispose();
    this._editor = undefined;
  }

  private _applyDecorations() {
    if (!this._editor || !monacoApi || this.changedLines.length === 0) return;
    const m = monacoApi;

    const decorations: monaco.editor.IModelDeltaDecoration[] = this.changedLines.map((line) => ({
      range: new m.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: 'cv-changed-line',
        glyphMarginClassName: 'cv-changed-glyph',
      },
    }));

    if (this._decorations) {
      this._decorations.set(decorations);
    } else {
      this._decorations = this._editor.createDecorationsCollection(decorations);
    }
  }

  private _applyDiagnosticMarkers() {
    if (!this._editor || !monacoApi) return;
    const m = monacoApi;
    const model = this._editor.getModel();
    if (!model) return;

    // Filter diagnostics to current file (match by suffix — diagnostics may use absolute paths)
    const fileDiags = this.diagnostics.filter((d) => {
      if (!this.filePath) return false;
      return d.file === this.filePath || d.file.endsWith('/' + this.filePath);
    });

    const markers: monaco.editor.IMarkerData[] = fileDiags.map((d) => ({
      severity: d.severity === 'error' ? m.MarkerSeverity.Error : m.MarkerSeverity.Warning,
      startLineNumber: d.line,
      startColumn: d.column,
      endLineNumber: d.line,
      endColumn: d.column + 1,
      message: d.message,
      source: d.source || 'diagnostics',
      code: d.code || undefined,
    }));

    m.editor.setModelMarkers(model, 'farmslot-diagnostics', markers);
  }

  private _getWidgetLayout(): { paddingLeft: number; totalWidth: number } {
    if (!this._editor) return { paddingLeft: 48, totalWidth: 600 };
    const layout = this._editor.getLayoutInfo();
    // totalWidth = contentLeft + contentWidth = everything left of minimap/scrollbar
    const totalWidth = layout.contentLeft + layout.contentWidth;
    const paddingLeft = layout.contentLeft + 8;
    return { paddingLeft, totalWidth };
  }

  private _updateWidgetWidths() {
    const { paddingLeft, totalWidth } = this._getWidgetLayout();
    for (const node of this._viewZoneDomNodes) {
      node.style.width = `${totalWidth}px`;
      node.style.paddingLeft = `${paddingLeft}px`;
    }
  }

  private _applyCommentDecorations() {
    if (!this._editor || !monacoApi) return;
    const m = monacoApi;
    const threads = this.commentThreads.filter((t) => t.line !== null);

    if (threads.length === 0) {
      this._commentDecorations?.clear();
      return;
    }

    const decorations: monaco.editor.IModelDeltaDecoration[] = threads.map((t) => ({
      range: new m.Range(t.line!, 1, t.line!, 1),
      options: {
        isWholeLine: true,
        className: 'cv-comment-line',
        glyphMarginClassName: t.resolved ? 'cv-comment-glyph resolved' : 'cv-comment-glyph',
      },
    }));

    if (this._commentDecorations) {
      this._commentDecorations.set(decorations);
    } else {
      this._commentDecorations = this._editor.createDecorationsCollection(decorations);
    }
  }

  private _applyCommentZones() {
    if (!this._editor) return;

    // Remove old zones
    this._editor.changeViewZones((accessor) => {
      for (const id of this._viewZoneIds) accessor.removeZone(id);
    });
    this._viewZoneIds = [];
    this._viewZoneDomNodes = [];

    const threads = this.commentThreads.filter((t) => t.line !== null && t.comments.length > 0);
    if (threads.length === 0 || !this.showComments) return;

    const { paddingLeft, totalWidth } = this._getWidgetLayout();

    // Pre-render in hidden measurer to get accurate heights
    const measurer = document.createElement('div');
    measurer.style.cssText = `position:absolute;visibility:hidden;width:${totalWidth}px`;
    document.body.appendChild(measurer);

    const widgets: Array<{ thread: PRReviewThread; domNode: HTMLElement; height: number }> = [];
    for (const thread of threads) {
      const collapsed = this._collapsedThreadIds.has(thread.id);
      const domNode = this._createThreadWidget(thread, collapsed);
      // padding-left puts the content in the code area; width + box-sizing keeps it from overflowing
      domNode.style.cssText += `;width:${totalWidth}px;padding-left:${paddingLeft}px;padding-right:8px;box-sizing:border-box;overflow:hidden`;

      measurer.appendChild(domNode);
      const height = domNode.offsetHeight + 4;
      measurer.removeChild(domNode);
      widgets.push({ thread, domNode, height });
    }
    document.body.removeChild(measurer);

    this._editor.changeViewZones((accessor) => {
      for (const { thread, domNode, height } of widgets) {
        this._viewZoneDomNodes.push(domNode);
        const id = accessor.addZone({
          afterLineNumber: thread.line!,
          heightInPx: Math.max(24, height),
          domNode,
          suppressMouseDown: false,
        });
        this._viewZoneIds.push(id);
      }
    });
  }

  private _createThreadWidget(thread: PRReviewThread, collapsed: boolean): HTMLElement {
    const widget = document.createElement('div');
    widget.className = 'cv-thread-widget';
    if (thread.resolved) widget.classList.add('resolved');
    if (collapsed) widget.classList.add('collapsed');

    const first = thread.comments[0];
    const replyCount = thread.comments.length - 1;

    // Header — always visible, acts as collapse/expand toggle
    const header = document.createElement('div');
    header.className = 'cv-tw-header';
    header.innerHTML = `
      <span class="cv-tw-toggle">${collapsed ? '\u25B8' : '\u25BE'}</span>
      <span class="cv-tw-author">${this._esc(first.author)}</span>
      ${thread.resolved ? '<span class="cv-tw-badge resolved">resolved</span>' : ''}
      ${thread.outdated ? '<span class="cv-tw-badge outdated">outdated</span>' : ''}
      ${collapsed && replyCount > 0 ? `<span class="cv-tw-reply-count">${replyCount + 1} comments</span>` : ''}
      ${collapsed ? `<span class="cv-tw-collapsed-preview">${this._esc(this._truncate(first.body, 60))}</span>` : ''}
      <span class="cv-tw-time">${this._timeAgo(first.createdAt)}</span>
    `;
    header.style.cursor = 'pointer';
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      if (collapsed) {
        this._collapsedThreadIds.delete(thread.id);
      } else {
        this._collapsedThreadIds.add(thread.id);
      }
      this._applyCommentZones();
    });
    widget.appendChild(header);

    if (collapsed) return widget;

    // Body (markdown)
    const body = document.createElement('div');
    body.className = 'cv-tw-body';
    body.innerHTML = DOMPurify.sanitize(marked.parse(first.body, { async: false }) as string);
    widget.appendChild(body);

    // All replies inline
    if (replyCount > 0) {
      for (const c of thread.comments.slice(1)) {
        const commentEl = document.createElement('div');
        commentEl.className = 'cv-tw-comment';
        commentEl.innerHTML = `
          <div class="cv-tw-header">
            <span class="cv-tw-author">${this._esc(c.author)}</span>
            <span class="cv-tw-time">${this._timeAgo(c.createdAt)}</span>
          </div>
          <div class="cv-tw-body">${DOMPurify.sanitize(marked.parse(c.body, { async: false }) as string)}</div>
        `;
        widget.appendChild(commentEl);
      }
    }

    return widget;
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private _truncate(s: string, max: number): string {
    const flat = s.replace(/\n/g, ' ');
    return flat.length > max ? flat.substring(0, max) + '...' : flat;
  }

  private _timeAgo(iso: string): string {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return `${Math.floor(diff / 86400_000)}d ago`;
  }

  override render() {
    return html`
      <style>
        code-viewer {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          font-family: ${fonts.mono};
        }
        .cv-header {
          display: flex;
          align-items: center;
          gap: ${spacing.md};
          padding: ${spacing.sm} ${spacing.md};
          background: ${colors.bgCard};
          border-radius: ${radii.md} ${radii.md} 0 0;
          height: 32px;
          box-sizing: border-box;
          flex-shrink: 0;
        }
        .cv-filename {
          color: ${colors.textPrimary};
          font-size: ${fonts.sizeSm};
          font-weight: 600;
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .cv-lang {
          font-size: ${fonts.sizeXs};
          padding: 1px 6px;
          border-radius: 9px;
          background: ${colors.accent}22;
          color: ${colors.accent};
          text-transform: uppercase;
          font-weight: 600;
          letter-spacing: 0.04em;
        }
        .cv-editor {
          flex: 1;
          min-height: 0;
          border-radius: 0 0 ${radii.md} ${radii.md};
          overflow: hidden;
        }
        /* Changed line decorations */
        .cv-changed-line {
          background: rgba(63, 185, 80, 0.08) !important;
        }
        .cv-changed-glyph {
          background: ${colors.statusOk};
          width: 3px !important;
          margin-left: 3px;
          border-radius: 1px;
        }
        /* Comment line decorations */
        .cv-comment-line {
          background: rgba(99, 102, 241, 0.06) !important;
        }
        .cv-comment-glyph {
          background: ${colors.accent};
          width: 3px !important;
          margin-left: 3px;
          border-radius: 1px;
        }
        .cv-comment-glyph.resolved {
          background: ${colors.statusOk};
          opacity: 0.5;
        }

        /* Inline thread widgets (ViewZones) */
        .cv-thread-widget {
          background: #1a1a2e;
          border: 1px solid #2a2a44;
          border-left: 3px solid ${colors.accent};
          border-radius: 0 4px 4px 0;
          padding: 6px 10px;
          font-family: ${fonts.mono};
          font-size: 11px;
          color: ${colors.textSecondary};
          line-height: 1.4;
          overflow: hidden;
          box-sizing: border-box;
        }
        .cv-thread-widget.resolved {
          border-left-color: ${colors.statusOk};
          opacity: 0.6;
        }
        .cv-thread-widget.resolved:hover {
          opacity: 0.9;
        }
        .cv-thread-widget.collapsed {
          padding: 3px 10px;
        }

        .cv-tw-header {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 2px;
          font-size: 10px;
        }
        .cv-thread-widget.collapsed .cv-tw-header {
          margin-bottom: 0;
        }
        .cv-tw-toggle {
          font-size: 9px;
          color: ${colors.textMuted};
          width: 10px;
          flex-shrink: 0;
        }
        .cv-tw-collapsed-preview {
          color: ${colors.textMuted};
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
          min-width: 0;
        }
        .cv-tw-author {
          font-weight: 600;
          color: ${colors.textPrimary};
        }
        .cv-tw-badge {
          font-size: 9px;
          padding: 0 4px;
          border-radius: 3px;
          font-weight: 600;
        }
        .cv-tw-badge.resolved {
          background: ${colors.statusOk}22;
          color: ${colors.statusOk};
        }
        .cv-tw-badge.outdated {
          background: ${colors.statusWarn}22;
          color: ${colors.statusWarn};
        }
        .cv-tw-time {
          color: ${colors.textMuted};
          margin-left: auto;
        }

        .cv-tw-body {
          color: ${colors.textSecondary};
          word-break: break-word;
          overflow-wrap: break-word;
          overflow: hidden;
        }
        .cv-tw-body p {
          margin: 2px 0;
        }
        .cv-tw-body pre {
          background: ${colors.bgBase};
          border: 1px solid #2a2a44;
          border-radius: 3px;
          padding: 3px 6px;
          font-size: 10px;
          overflow-x: auto;
          margin: 3px 0;
        }
        .cv-tw-body code {
          background: ${colors.bgBase};
          padding: 1px 3px;
          border-radius: 2px;
          font-size: 10px;
          color: ${colors.accent};
        }
        .cv-tw-body pre code {
          background: none;
          padding: 0;
          color: ${colors.textSecondary};
        }
        .cv-tw-body a {
          color: ${colors.accent};
          text-decoration: none;
        }
        .cv-tw-body a:hover {
          text-decoration: underline;
        }

        .cv-tw-reply-count {
          color: ${colors.accent};
          font-weight: 600;
        }

        .cv-tw-comment {
          padding: 4px 0;
          border-top: 1px solid #1e1e36;
        }
        .cv-tw-comment:first-child {
          border-top: none;
        }
      </style>
      <div class="cv-header">
        <span class="cv-filename">${this.filename || 'untitled'}</span>
        ${this.language ? html`<span class="cv-lang">${this.language}</span>` : ''}
      </div>
      <div class="cv-editor"></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'code-viewer': CodeViewer;
  }
}
