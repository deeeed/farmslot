import assert from 'node:assert/strict';
import test from 'node:test';

import type { FlowType } from '@farmslot/protocol';

import {
  loadDispatchTemplatePreference,
  persistDispatchTemplatePreference,
  selectedExecutionTemplatePreference,
} from './dispatch-wizard-template-preferences.js';

function withStorage(run: () => void): void {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

test('dispatch template preferences retain a template per domain and mode', () => {
  withStorage(() => {
    const project = 'example-app-farm';
    const flowType: FlowType = 'dev';
    persistDispatchTemplatePreference({
      project,
      flowType,
      domain: 'payments',
      mode: 'interactive',
      executionTemplateId: 'payments/app-interactive',
    });
    persistDispatchTemplatePreference({
      project,
      flowType,
      domain: 'payments',
      mode: 'autonomous',
      executionTemplateId: 'payments/app-autonomous',
    });

    const preference = loadDispatchTemplatePreference(project, flowType);
    assert.equal(preference?.domain, 'payments');
    assert.equal(preference?.mode, 'autonomous');
    assert.equal(
      selectedExecutionTemplatePreference(preference, 'payments', 'interactive'),
      'payments/app-interactive',
    );
    assert.equal(
      selectedExecutionTemplatePreference(preference, 'payments', 'autonomous'),
      'payments/app-autonomous',
    );
  });
});

test('dispatch template preferences ignore malformed storage', () => {
  withStorage(() => {
    localStorage.setItem('farmslot.dispatch-template.project.dev', '{"mode":"surprise"}');
    assert.equal(loadDispatchTemplatePreference('project', 'dev'), null);
  });
});
