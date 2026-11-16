import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

Object.assign(globalThis, { location: new URL('http://localhost/') });
mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });
mock.module('../shared/source-status-panel.js', { namedExports: {} });
mock.module('./execution-template-preview-modal.js', { namedExports: {} });
mock.module('./dispatch-native-profiles.js', { namedExports: {} });
mock.module('./recipe-compatibility-panel.js', { namedExports: {} });
mock.module('./dispatch-wizard-view-renderer.js', {
  namedExports: { renderDispatchWizardView: () => undefined },
});
const loaders = await import('./dispatch-wizard-loaders.js');
mock.module('./dispatch-wizard-loaders.js', {
  namedExports: {
    ...loaders,
    requestDispatchWizardCandidates: async () => ({ candidates: [] }),
    requestDispatchProjectMatch: async () => ({ project: null }),
  },
});

const { DispatchWizard } = await import('./dispatch-wizard.js');
const { DispatchConfigEditor } = await import('../shared/dispatch-config-editor.js');

function label(picker: ReviewDispatchViewModel): string {
  const id = picker.rows[0].id;
  if (picker.selection?.runner !== 'pi') picker.setRunner(id, 'pi');
  return picker.effortChoices(id)[0].label;
}

interface WizardSync {
  _flowType: string | null;
  _executionPicker: ReviewDispatchViewModel;
  _reviewPicker: ReviewDispatchViewModel;
  _projectConfigs: readonly unknown[];
  _project: string;
  _ticketId: string;
  _normalizedTicket: string;
  _workflowSelectionKey: string;
  _syncWorkflowSelection(): void;
}

function put(target: object, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(target, key, { value, writable: true, configurable: true });
  }
}

function wizard(): WizardSync {
  const view = Object.create(DispatchWizard.prototype) as WizardSync;
  put(view, {
    _flowType: null,
    _executionPicker: new ReviewDispatchViewModel({
      context: { allowedActions: ['dispatch'] },
    }),
    _reviewPicker: new ReviewDispatchViewModel({
      context: {
        allowedActions: ['dispatch'],
        allowSequence: true,
        allowEmpty: true,
      },
      sequence: [],
    }),
    _projectConfigs: [],
    _project: '',
    _ticketId: '',
    _normalizedTicket: '',
    _workflowSelectionKey: '',
  });
  return view;
}

test('the dispatch wizard primary picker labels high for every pi flow', () => {
  const view = wizard();
  view._flowType = 'review-pr';
  view._syncWorkflowSelection();
  assert.equal(label(view._executionPicker), 'Runner default · high');
  view._flowType = 'dev';
  view._syncWorkflowSelection();
  assert.equal(label(view._executionPicker), 'Runner default · high');
  view._flowType = 'qa';
  view._syncWorkflowSelection();
  assert.equal(label(view._executionPicker), 'Runner default · high');
});

interface EditorSync {
  flowType: string;
  runner: string;
  model: string;
  effort: string;
  reviewMode: string;
  reviewLineages: readonly unknown[];
  executionPicker: ReviewDispatchViewModel;
  willUpdate(changed: Map<string, unknown>): void;
}

function editor(): EditorSync {
  const view = Object.create(DispatchConfigEditor.prototype) as EditorSync;
  put(view, {
    flowType: '',
    runner: 'pi',
    model: '',
    effort: '',
    reviewMode: 'cold',
    reviewLineages: [],
    executionPicker: new ReviewDispatchViewModel({
      context: { allowedActions: ['dispatch'] },
    }),
    reviewPicker: new ReviewDispatchViewModel({
      context: {
        allowedActions: ['dispatch'],
        allowSequence: true,
        allowEmpty: true,
      },
      sequence: [],
    }),
  });
  return view;
}

test('the config editor primary picker labels high for every pi flow', () => {
  const view = editor();
  view.flowType = 'review-pr';
  view.willUpdate(new Map([['flowType', '']]));
  assert.equal(label(view.executionPicker), 'Runner default · high');
  view.flowType = 'qa';
  view.willUpdate(new Map([['flowType', 'review-pr']]));
  assert.equal(label(view.executionPicker), 'Runner default · high');
  view.flowType = 'dev';
  view.willUpdate(new Map([['flowType', 'qa']]));
  assert.equal(label(view.executionPicker), 'Runner default · high');
});
