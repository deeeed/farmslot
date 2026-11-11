import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

import { createViewStateContext, type ViewStateField, viewToggleField } from '@farmslot/protocol';
import { type ChecklistRowView, checklistStepDetailKey } from '@farmslot/review-dispatch';

interface Element {
  type: unknown;
  props: Record<string, unknown>;
}
function element(value: unknown): Element {
  assert.ok(value && typeof value === 'object' && 'type' in value && 'props' in value);
  assert.ok(value.props && typeof value.props === 'object');
  return { type: value.type, props: value.props as Record<string, unknown> };
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object') return text(element(value).props.children);
  return value == null || typeof value === 'boolean' ? '' : String(value);
}

// Execute the actual row and its onPress callback with primitive shims, as the
// connection-indicator tests do. This proves wiring, not native layout or jank.
function renderer() {
  let params = new URLSearchParams();
  const choices = createViewStateContext({
    read: () => params,
    write: (next) => {
      params = next;
    },
    subscribe: () => () => {},
  });
  const modules: Record<string, unknown> = {
    react: {
      createElement: (type: unknown, props: object | null, ...children: unknown[]): Element => ({
        type,
        props: { ...props, children },
      }),
    },
    'react-native': {
      Pressable: 'Pressable',
      Text: 'Text',
      View: 'View',
      StyleSheet: { create: (value: unknown) => value },
    },
    '@farmslot/protocol': { viewToggleField },
    '@farmslot/review-dispatch': { checklistStepDetailKey },
    '../lib/task-progress': {},
    '../lib/task-progress-view': { taskStepStatusColor: () => '#aaa' },
    '../lib/theme': { colors: {}, fonts: {}, radii: {}, spacing: {} },
    './TaskSubtaskBlock': {},
    './view-state': {
      useViewChoice: (field: ViewStateField<boolean>) => [
        choices.get(field),
        (update: (value: boolean) => boolean) => choices.set(field, update(choices.get(field))),
      ],
    },
  };
  const source = readFileSync(new URL('./TaskProgressPanel.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(`${compiled}\nexports.row = ChecklistStepRow;`, {
    exports,
    require: (name: string) => {
      assert.ok(name in modules, name);
      return modules[name];
    },
  });
  const row = exports.row;
  assert.equal(typeof row, 'function');
  if (typeof row !== 'function') throw new Error('Missing row');
  const render = (input: ChecklistRowView, runId = 'run-a', subtaskId?: string) =>
    element(row({ row: input, detailScope: { runId, checklist: 'CHECKLIST.md', subtaskId } }));
  return { render, params: () => params };
}

test('native detail row starts closed, toggles by pressing and leaves completion unchanged', () => {
  const f = renderer();
  const row: ChecklistRowView = {
    step: { index: 1, name: 'Inspect', status: 'done', detail: 'Read actual source.' },
    icon: '✓',
    duration: null,
    live: false,
  };
  const before = JSON.stringify(row);
  const closed = f.render(row);
  assert.doesNotMatch(text(closed), /Read actual source/);
  const children = closed.props.children;
  assert.ok(Array.isArray(children));
  const button = element(children[0]);
  assert.equal(button.type, 'Pressable');
  const state = button.props.accessibilityState;
  assert.ok(state && typeof state === 'object' && 'expanded' in state);
  assert.equal(state.expanded, false);
  const press = button.props.onPress;
  assert.equal(typeof press, 'function');
  if (typeof press !== 'function') throw new Error('Missing onPress');
  press();
  assert.match(text(f.render(row)), /Read actual source/);
  assert.doesNotMatch(text(f.render(row, 'run-b')), /Read actual source/);
  assert.doesNotMatch(text(f.render(row, 'run-a', 'child')), /Read actual source/);
  press();
  assert.doesNotMatch(text(f.render(row)), /Read actual source/);
  assert.equal(f.params().has('stepDetails'), false);
  assert.equal(JSON.stringify(row), before);
});

test('native steps without instructions have no disclosure control', () => {
  const view = renderer().render({
    step: { index: 1, name: 'Inspect', status: 'pending' },
    icon: '○',
    duration: null,
    live: false,
  });
  const children = view.props.children;
  assert.ok(Array.isArray(children));
  assert.equal(element(children[0]).type, 'View');
});
