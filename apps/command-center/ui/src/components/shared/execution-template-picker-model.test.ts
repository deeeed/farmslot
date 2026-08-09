import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecutionTemplateCatalogOption, ExecutionTemplateOptions } from '@farmslot/protocol';

import {
  activeFilterSummary,
  deriveExecutionTemplatePickerView,
  optionDomains,
} from './execution-template-picker-model.js';

function option(
  overrides: Partial<ExecutionTemplateCatalogOption> & { id: string },
): ExecutionTemplateCatalogOption {
  return {
    sourceId: 'project:example-farm',
    flow: 'fix-bug',
    runMode: 'autonomous',
    platforms: ['mobile'],
    labels: [],
    relativePath: `${overrides.id}.md`,
    sha256: `sha-${overrides.id}`,
    title: overrides.id,
    sourceKind: 'project',
    ...overrides,
  };
}

function catalog(overrides: Partial<ExecutionTemplateOptions>): ExecutionTemplateOptions {
  return {
    configured: true,
    options: [],
    availableDomains: [],
    unavailableSources: [],
    filteredSources: [],
    ...overrides,
  };
}

const perpsOption = option({
  id: 'fix-bug/sentry-cuf-autonomous.mobile',
  sourceId: 'team:perps',
  sourceKind: 'workspace',
  labels: ['domain:perps'],
});
const generalOption = option({ id: 'fix-bug/default' });

test('rows carry stripped domains, selection, and gateway-default provenance', () => {
  const view = deriveExecutionTemplatePickerView(
    catalog({
      options: [generalOption, perpsOption],
      selectedId: 'fix-bug/default',
      selectionReason: 'configured-default',
    }),
    'fix-bug/sentry-cuf-autonomous.mobile',
    { domain: 'perps', runMode: 'autonomous' },
  );
  assert.equal(view.resultCount, 2);
  assert.deepEqual(optionDomains(perpsOption), ['perps']);
  assert.equal(view.selectionValid, true);
  assert.equal(view.selectedRow?.option.id, 'fix-bug/sentry-cuf-autonomous.mobile');
  assert.equal(view.rows[0]?.gatewayDefault, true);
  assert.equal(view.rows[0]?.selected, false);
  // Explicit selection reports itself, not the gateway default's reason.
  assert.equal(
    view.selectionSummary,
    'fix-bug/sentry-cuf-autonomous.mobile · team:perps · explicit',
  );
});

test('a filter change that drops the selected id invalidates the selection', () => {
  // After a refetch without the perps domain the perps option is gone; the
  // stale selected id must be flagged, never silently kept (AC7).
  const view = deriveExecutionTemplatePickerView(
    catalog({ options: [generalOption] }),
    'fix-bug/sentry-cuf-autonomous.mobile',
    { domain: '', runMode: 'autonomous' },
  );
  assert.equal(view.selectionValid, false);
  assert.equal(view.selectedRow, null);
});

test('empty catalogs name the active filters instead of collapsing to a blank state', () => {
  const view = deriveExecutionTemplatePickerView(catalog({ options: [] }), '', {
    domain: 'money-movement',
    runMode: 'interactive',
  });
  assert.equal(
    view.emptyStateMessage,
    'No compatible execution template for domain: money-movement · mode: interactive.',
  );
  assert.equal(
    activeFilterSummary({ domain: '', runMode: 'autonomous' }),
    'domain: general · mode: autonomous',
  );
});

test('unavailable and domain-filtered sources surface as notices with the enabling domains', () => {
  const view = deriveExecutionTemplatePickerView(
    catalog({
      options: [generalOption],
      unavailableSources: [{ id: 'package:consensys-recipe-cook', reason: 'missing-root' }],
      filteredSources: [{ id: 'team:perps', reason: 'domain-restricted', domains: ['perps'] }],
    }),
    '',
    { domain: '', runMode: 'autonomous' },
  );
  assert.deepEqual(view.sourceNotices, [
    'package:consensys-recipe-cook: missing-root',
    'team:perps: domain-restricted — select domain perps to include it',
  ]);
});

test('gateway-default selection summary is reported when nothing is explicitly selected', () => {
  const view = deriveExecutionTemplatePickerView(
    catalog({
      options: [generalOption],
      selectedId: 'fix-bug/default',
      selectionReason: 'single-general-candidate',
    }),
    '',
    { domain: '', runMode: 'autonomous' },
  );
  assert.equal(
    view.selectionSummary,
    'fix-bug/default · project:example-farm · single-general-candidate',
  );
});

test('a catalog from an older gateway without filteredSources yields no notices', () => {
  const legacy = catalog({ options: [generalOption] });
  delete (legacy as Partial<ExecutionTemplateOptions>).filteredSources;
  const view = deriveExecutionTemplatePickerView(legacy, '', {
    domain: '',
    runMode: 'autonomous',
  });
  assert.deepEqual(view.sourceNotices, []);
});
