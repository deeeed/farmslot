import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, mock, test } from 'node:test';

import type { PRReviewThread } from '@farmslot/protocol';

const frames: FrameRequestCallback[] = [];
for (const [name, value] of Object.entries({
  self: globalThis,
  requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
})) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true });
  after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}

class Range {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {}
}
const positions: Array<{ lineNumber: number; column: number }> = [];
const contentListeners: Array<() => void> = [];
const revealed: number[] = [];
const decorated: Array<{ range: Range; options: { className?: string } }> = [];
let modelLineCount = 570;
const editor = {
  getModel: () => ({ getLineCount: () => modelLineCount }),
  changeViewZones: (change: (accessor: { removeZone(): void; addZone(): void }) => void) =>
    change({
      removeZone() {},
      addZone() {
        throw new Error('An invalid line received a view zone');
      },
    }),
  createDecorationsCollection: (entries: typeof decorated) => {
    decorated.push(...entries);
    return { set() {}, clear() {} };
  },
  onMouseDown() {},
  onDidChangeModelContent(listener: () => void) {
    contentListeners.push(listener);
  },
  onDidLayoutChange: () => ({ dispose() {} }),
  revealLineInCenter: (line: number) => revealed.push(line),
  setPosition: (next: { lineNumber: number; column: number }) => {
    positions.push(next);
  },
};
// Styles do not affect editor selection, and Node cannot load Vite's CSS import.
const css = registerHooks({
  load(url, context, next) {
    if (url.includes('/monaco-editor/min/vs/editor/editor.main.css'))
      return { format: 'module', source: '', shortCircuit: true };
    return next(url, context);
  },
});
after(() => css.deregister());
const defaults = { setDiagnosticsOptions() {} };
mock.module('monaco-editor/esm/vs/language/typescript/monaco.contribution', {
  namedExports: { typescriptDefaults: defaults, javascriptDefaults: defaults },
});
mock.module('monaco-editor', {
  namedExports: {
    Range,
    Uri: { parse: (value: string) => value },
    languages: { registerLinkProvider() {} },
    editor: { createModel() {}, create: () => editor, defineTheme() {}, registerEditorOpener() {} },
  },
});
mock.module('../../utils/shadow-css.js', { namedExports: { adoptDocumentCss() {} } });
mock.module('../../utils/markdown.js', {
  namedExports: { renderMarkdown: (text: string) => text },
});
mock.module('../shared/gateway-media-src.js', { namedExports: { gatewayMediaHtml() {} } });
const { CodeViewer } = await import('./code-viewer.js');

interface Viewer {
  revealLine: number;
  _editor?: typeof editor;
  updated(changed: Map<string, unknown>): void;
  firstUpdated(): Promise<void>;
  _anchoredCommentThreads(): PRReviewThread[];
}

test('a line comment selected before Monaco loads reveals its exact line and inline thread', async () => {
  // Only the editor boundary is fake. Exercise the production lazy init and update order.
  const viewer = Object.create(CodeViewer.prototype) as Viewer;
  let zones = 0;
  const threads: PRReviewThread[] = [
    {
      id: 'finding-462',
      path: 'mobileInfrastructure.ts',
      line: 462,
      resolved: false,
      outdated: false,
      comments: [
        {
          id: 1,
          body: 'Check the resulting position',
          author: 'reviewer',
          createdAt: '2026-10-21T00:00:00Z',
          updatedAt: '2026-10-21T00:00:00Z',
        },
      ],
    },
  ];
  Object.assign(viewer, {
    requestUpdate() {},
    querySelector: () => ({}),
    content: Array.from({ length: 570 }, (_, index) => `source line ${index + 1}`).join('\n'),
    language: 'typescript',
    filename: 'mobileInfrastructure.ts',
    filePath: 'mobileInfrastructure.ts',
    changedLines: [],
    commentThreads: threads,
    showComments: true,
    revealLine: 462,
    _applyCommentZones(this: Viewer) {
      if (this._editor) zones++;
    },
  });
  const ready = viewer.firstUpdated();
  viewer.updated(
    new Map<string, unknown>([
      ['revealLine', 0],
      ['commentThreads', []],
    ]),
  );
  assert.equal(positions.length, 0, 'selection arrived while the editor was still loading');
  await ready;
  frames.shift()?.(0);
  assert.deepEqual(positions.at(-1), { lineNumber: 462, column: 1 });
  assert.deepEqual(revealed, [462]);
  assert.ok(
    decorated.some(
      (entry) =>
        entry.range.startLineNumber === 462 && entry.options.className === 'cv-selected-line',
    ),
    'the comment line is highlighted',
  );
  assert.equal(zones, 1, 'the inline comment is applied when the editor becomes ready');

  viewer.revealLine = 479;
  viewer.updated(new Map<string, unknown>([['revealLine', 462]]));
  assert.equal(positions.at(-1)?.lineNumber, 479, 'later comments in the same file still reveal');
});

for (const [sourceLines, findingLine] of [
  [223, 479],
  [223, 224],
  [570, 571],
]) {
  test(`finding ${findingLine} cannot anchor after ${sourceLines} newline-terminated source lines`, () => {
    modelLineCount = sourceLines + 1;
    const previousPositions = positions.length;
    const previousDecorations = decorated.length;
    const viewer = Object.create(CodeViewer.prototype) as Viewer;
    Object.assign(viewer, {
      requestUpdate() {},
      _editor: editor,
      content:
        Array.from({ length: sourceLines }, (_, index) => `source line ${index + 1}`).join('\n') +
        '\n',
      revealLine: findingLine,
      commentThreads: [
        {
          id: 'finding',
          path: 'usePerpsCloseAllCalculations.ts',
          line: findingLine,
          resolved: false,
          outdated: false,
          comments: [
            {
              id: 2,
              body: 'Finding at its real line',
              author: 'reviewer',
              createdAt: '2026-10-22',
              updatedAt: '2026-10-22',
            },
          ],
        },
      ] satisfies PRReviewThread[],
      showComments: true,
      _viewZoneIds: [],
      _viewZoneDomNodes: [],
      _disposeCommentBodies() {},
    });
    assert.deepEqual(
      viewer._anchoredCommentThreads(),
      [],
      'only real source lines can receive a comment zone',
    );
    viewer.updated(
      new Map<string, unknown>([
        ['revealLine', 0],
        ['commentThreads', []],
      ]),
    );
    assert.equal(positions.length, previousPositions, 'no cursor at a nonexistent trailing line');
    assert.equal(decorated.length, previousDecorations, 'no comment decoration clamped to EOF');
  });
}

test('typing is reported, and a new content never discards typing the host has not adopted', async () => {
  let value = 'saved\n';
  let models = 0;
  const events: CustomEvent[] = [];
  const viewer = Object.create(CodeViewer.prototype) as Viewer & {
    content: string;
    contentRevision: number;
  };
  const typingEditor = {
    ...editor,
    getModel: () => ({ getValue: () => value, getLineCount: () => 1, dispose() {} }),
    getValue: () => value,
    setModel() {
      models++;
    },
  };
  Object.assign(viewer, {
    requestUpdate() {},
    querySelector: () => ({}),
    dispatchEvent: (event: CustomEvent) => events.push(event),
    content: 'saved\n',
    language: 'typescript',
    filePath: 'src/app.ts',
    changedLines: [],
    commentThreads: [],
    showComments: false,
    revealLine: 0,
    diagnostics: [],
    _applyCommentZones() {},
    _applyDiagnosticMarkers() {},
  });
  const ready = viewer.firstUpdated();
  await ready;
  frames.shift()?.(0);
  Object.assign(viewer, { _editor: typingEditor });

  // The user types; the editor reports it.
  value = 'typed\n';
  contentListeners.at(-1)?.();
  assert.deepEqual(events.at(-1)?.detail, { content: 'typed\n' });
  assert.equal(events.at(-1)?.type, 'content-change');

  // A worker's content arriving before the host adopts the typing keeps the typing.
  viewer.content = 'worker\n';
  viewer.updated(new Map<string, unknown>([['content', 'saved\n']]));
  assert.equal(models, 0);
  // The host adopts the typing: nothing to replace.
  viewer.content = 'typed\n';
  viewer.updated(new Map<string, unknown>([['content', 'worker\n']]));
  assert.equal(models, 0);
  // With nothing unsaved, a new content replaces the text.
  viewer.content = 'worker\n';
  viewer.updated(new Map<string, unknown>([['content', 'typed\n']]));
  assert.equal(models, 1);
  // A revision replaces the text even over typing, such as keeping the current file.
  value = 'mine\n';
  viewer.contentRevision = 1;
  viewer.updated(new Map<string, unknown>([['contentRevision', 0]]));
  assert.equal(models, 2);
});
