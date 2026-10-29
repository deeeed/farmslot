import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import ts from 'typescript';

import {
  type RoadmapDeliverySummary,
  roadmapDeliveryView,
  type RoadmapItem,
} from '@farmslot/protocol';

// Execute production observation adoption and selection without booting the UI.
const source = ts.createSourceFile(
  'roadmap-panel.ts',
  readFileSync(new URL('./roadmap-panel.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const panel = source.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'RoadmapPanel',
);
assert(panel);
const members = panel.members.filter(
  (member) =>
    member.name &&
    ['_adoptListResult', '_selected', '_resolveSelectedItem'].includes(member.name.getText(source)),
);
assert.equal(members.length, 3);
const compiled = ts.transpileModule(
  `class Panel { ${members.map((member) => member.getText(source)).join('\n')} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

test('a current observation rebinds editor and detail when selection leaves the outcome filter', () => {
  const rows = [
    { id: 'first', title: 'First', fileHash: 'first-hash' },
    { id: 'second', title: 'Second', fileHash: 'second-hash' },
  ] as RoadmapItem[];
  const summaries: RoadmapDeliverySummary[] = [
    { roadmapItemId: 'first', status: 'delivered' } as RoadmapDeliverySummary,
    { roadmapItemId: 'second', status: 'active' } as RoadmapDeliverySummary,
  ];
  const Panel = new Function(`${compiled}; return Panel;`)();
  const state = new Panel();
  Object.assign(state, {
    _selectedId: 'first',
    _allItems: rows,
    _deliverySummaries: [],
    items: null,
    _listQuery: { ready: true },
    _selectionGeneration: 0,
    _editHash: 'first-hash',
    _editorMode: 'view',
    _deliveredExpanded: false,
  });
  Object.defineProperty(state, '_items', {
    get: () => roadmapDeliveryView(state._allItems, state._deliverySummaries, 'undelivered').items,
  });
  let editor = rows[0];
  let detailId = 'first';
  let urlWrites = 0;
  let editorWrites = 0;
  state._syncEditor = (item: RoadmapItem) => {
    editorWrites++;
    editor = item;
    state._selectedId = item.id;
    state._editHash = item.fileHash;
    state._syncDeliveryDetail(item.id);
  };
  state._writeUrlState = () => {
    urlWrites++;
  };
  state._syncDeliveryDetail = (id: string) => {
    detailId = id;
  };
  state._adoptListResult({ items: rows, delivery: summaries });
  assert.equal(state._selected.id, 'second');
  assert.equal(editor.title, 'Second');
  assert.equal(editor.fileHash, 'second-hash');
  assert.equal(detailId, 'second');
  assert.equal(urlWrites, 1);
  state._adoptListResult({ items: rows, delivery: summaries });
  assert.equal(editorWrites, 1, 'a retained selection keeps its existing editor');
  state._editorMode = 'edit';
  state._adoptListResult({
    items: rows.map((item) =>
      item.id === 'second' ? { ...item, fileHash: 'external-change' } : item,
    ),
    delivery: summaries,
  });
  assert.equal(editorWrites, 1, 'a current observation cannot overwrite an open draft');
  assert.equal(editor.fileHash, 'second-hash', 'the draft keeps its conditional-save base');
  state._listQuery.ready = false;
  state._adoptListResult({ items: [], delivery: [] });
  assert.equal(state._selectedId, 'second', 'an incomplete read cannot retire selection');
  assert.equal(editorWrites, 1, 'an incomplete read cannot clear the editor');
  assert.equal(editor.fileHash, 'second-hash');
});
