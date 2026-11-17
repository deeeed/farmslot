import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { html, nothing } from 'lit';

import {
  groupRunsByFamily,
  type Run,
  type RunFamilyGroup,
  type RunListRow,
} from '@farmslot/protocol';

import { installFakeGateway } from '../../testing/fake-gateway.js';
import { litText } from '../../testing/lit-text.js';

mock.module('../diff-viewer/diff-review.js', { namedExports: {} });
mock.module('../diff-viewer/code-viewer.js', { namedExports: {} });
mock.module('../terminal/terminal-view.js', { namedExports: {} });

function run(id: string, summary: string, day: number): Run {
  return {
    id,
    familyId: 'family',
    parentRunId: id === 'family' ? null : 'family',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'farm',
    ticketOrPr: id,
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: null, model: null },
    summary,
    createdAt: `2026-11-0${day}T00:00:00Z`,
    updatedAt: `2026-11-0${day}T00:00:00Z`,
  };
}

test('grouped rows retain an intermediate summary absent from the family heading', async (t) => {
  installFakeGateway(t);
  const { RunList } = await import('./run-list.js');
  for (const middleSummary of ['Distinct intermediate correction', 'Original']) {
    const runs = [
      run('family', 'Original issue', 1),
      run('middle', middleSummary, 2),
      run('latest', 'Latest follow-up', 3),
    ];
    const group = groupRunsByFamily(runs)[0];
    assert(group);
    interface View {
      renderFamilyGroup(group: RunFamilyGroup, checkboxes: boolean): { values: readonly unknown[] };
    }
    const view = Object.create(RunList.prototype) as View;
    Object.assign(view, {
      requestUpdate() {},
      prs: [],
      manageMode: false,
      renderFamilyReadinessBadges: () => nothing,
      renderCard: (row: RunListRow, _checkboxes: boolean, showSummary = true) =>
        html`${showSummary ? row.summary : nothing}`,
    });
    const family = view.renderFamilyGroup(group, false);
    const repeat = family.values.find(
      (value) => value && typeof value === 'object' && '_$litDirective$' in value,
    );
    assert(
      repeat && typeof repeat === 'object' && 'values' in repeat && Array.isArray(repeat.values),
    );
    const rowTemplate = repeat.values[2];
    assert(typeof rowTemplate === 'function');
    const rows = group.runs.map((row, index) => rowTemplate(row, index));
    assert.equal(litText(rows[group.runs.findIndex((row) => row.id === 'middle')]), middleSummary);
    const text = litText([family, rows]);
    for (const row of runs) assert(text.includes(row.summary ?? ''), row.id);
    assert.equal(text.split('Original issue').length - 1, 1, 'Do not duplicate the heading');
    assert.equal(text.split('Latest follow-up').length - 1, 1, 'Do not duplicate the heading');
  }
});
