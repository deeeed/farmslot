import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import ts from 'typescript';

import {
  type RoadmapDeliverySummary,
  roadmapDeliveryView,
  type RoadmapItem,
} from '@farmslot/protocol';

// Execute the production summary reload and selection getter without booting the UI.
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
    ['_reloadDelivery', '_selected', '_resolveSelectedItem'].includes(member.name.getText(source)),
);
assert.equal(members.length, 3);
const compiled = ts.transpileModule(
  `class Panel { ${members.map((member) => member.getText(source)).join('\n')} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

test('delivery refresh rebinds editor and detail when the selected item leaves the outcome filter', async () => {
  const rows = [
    { id: 'first', title: 'First', fileHash: 'first-hash' },
    { id: 'second', title: 'Second', fileHash: 'second-hash' },
  ] as RoadmapItem[];
  const summaries: RoadmapDeliverySummary[] = [
    { roadmapItemId: 'first', status: 'delivered' } as RoadmapDeliverySummary,
    { roadmapItemId: 'second', status: 'active' } as RoadmapDeliverySummary,
  ];
  const gateway = { request: async () => ({ delivery: summaries }) };
  const Panel = new Function('gateway', 'Methods', `${compiled}; return Panel;`)(gateway, {
    ROADMAP_LIST: 'roadmap.list',
  });
  const state = new Panel();
  Object.assign(state, {
    _selectedId: 'first',
    _deliverySummaries: [],
    _deliveryGeneration: 0,
    _filterProject: 'all',
    _filterStage: 'all',
    _includeArchived: false,
    _deliveryReloadInFlight: false,
    _deliveryReloadQueued: false,
    _deliveredExpanded: false,
  });
  Object.defineProperty(state, '_items', {
    get: () => roadmapDeliveryView(rows, state._deliverySummaries, 'undelivered').items,
  });
  let editor = rows[0];
  let detailId = 'first';
  let urlWrites = 0;
  state._syncEditor = (item: RoadmapItem) => {
    editor = item;
    state._selectedId = item.id;
  };
  state._writeUrlState = () => {
    urlWrites++;
  };
  state._loadDeliveryDetail = async (id: string) => {
    detailId = id;
  };
  await state._reloadDelivery();
  assert.equal(state._selected.id, 'second');
  assert.equal(editor.title, 'Second');
  assert.equal(editor.fileHash, 'second-hash');
  assert.equal(detailId, 'second');
  assert.equal(urlWrites, 1);
  await state._reloadDelivery();
  assert.equal(urlWrites, 1, 'a retained selection keeps its existing editor');
});
