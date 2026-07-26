import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ProjectVars } from '../core/config.js';

import {
  availableExecutionTemplateDomains,
  configuredExecutionTemplateOptions,
  readConfiguredExecutionTemplateSnapshot,
  resolveConfiguredExecutionTemplate,
  resolveConfiguredExecutionTemplateForSlot,
} from './execution-template-catalog.js';

function withProject(fn: (projectVars: ProjectVars) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-gateway-catalog-'));
  try {
    const templatesDir = path.join(root, 'templates');
    const teamRoot = path.join(root, 'team', 'checklists', 'fix-bug');
    mkdirSync(path.join(templatesDir, 'worker'), { recursive: true });
    mkdirSync(teamRoot, { recursive: true });
    writeFileSync(
      path.join(teamRoot, 'perps.mobile.md'),
      `---
id: fix-bug/perps-mobile
title: Perps mobile proof
description: Choose for autonomous Perps bug reproduction on Mobile.
flow: fix-bug
runMode: autonomous
platforms: [ios]
---

# Perps proof

- [ ] Validate the issue.
`,
    );
    fn({
      projectName: 'example-farm',
      projectConfig: path.join(root, 'project.json'),
      projectFixturesDir: path.join(root, 'fixtures'),
      projectTemplatesDir: templatesDir,
      projectJson: {
        name: 'example-farm',
        command_env: {
          domains: {
            perps: { set: { FEATURE: 'perps' } },
            'money-movement': { set: { FEATURE: 'money-movement' } },
          },
        },
        execution_templates: {
          sources: [
            {
              id: 'team:perps',
              kind: 'workspace',
              root: { projectPath: 'team' },
              subpath: 'checklists',
              domains: ['perps'],
            },
            {
              id: 'team:optional',
              kind: 'user',
              root: { env: 'FARMSLOT_TEST_UNSET_TEMPLATE_ROOT' },
            },
          ],
          defaults: [
            {
              when: {
                flow: 'fix-bug',
                platform: 'ios',
                runMode: 'autonomous',
                domain: 'perps',
              },
              templateId: 'fix-bug/perps-mobile',
            },
          ],
        },
      },
      runtimeDir: '.agent',
      artifactDir: '.task',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('configured capability lists domains, sources, selection, and unavailable roots', () => {
  withProject((projectVars) => {
    const capability = configuredExecutionTemplateOptions(projectVars, {
      flow: 'fix-bug',
      platform: 'ios',
      runMode: 'autonomous',
      domain: 'perps',
    });

    assert.deepEqual(availableExecutionTemplateDomains(projectVars), ['money-movement', 'perps']);
    assert.equal(capability.selectedId, 'fix-bug/perps-mobile');
    assert.equal(capability.selectionReason, 'configured-default');
    assert.deepEqual(
      capability.options.map((option) => ({
        id: option.id,
        sourceId: option.sourceId,
        sourceKind: option.sourceKind,
        description: option.description,
        labels: option.labels,
      })),
      [
        {
          id: 'fix-bug/perps-mobile',
          sourceId: 'team:perps',
          sourceKind: 'workspace',
          description: 'Choose for autonomous Perps bug reproduction on Mobile.',
          labels: ['domain:perps'],
        },
      ],
    );
    assert.deepEqual(capability.unavailableSources, [
      { id: 'team:optional', reason: 'missing-environment' },
    ]);
  });
});

test('configured resolution snapshots the same source digest exposed by capability options', () => {
  withProject((projectVars) => {
    const capability = configuredExecutionTemplateOptions(projectVars, {
      flow: 'fix-bug',
      platform: 'ios',
      runMode: 'autonomous',
      domain: 'perps',
    });
    const resolved = resolveConfiguredExecutionTemplate(projectVars, {
      flow: 'fix-bug',
      platform: 'ios',
      runMode: 'autonomous',
      domain: 'perps',
    });

    assert.equal(resolved.entry.id, capability.selectedId);
    assert.equal(resolved.reference.sha256, capability.options[0]?.sha256);
    assert.match(resolved.markdown, /Validate the issue/);
    assert.equal('path' in resolved.reference, false);
  });
});

test('configured preview reads only the exact catalog source and digest', () => {
  withProject((projectVars) => {
    const capability = configuredExecutionTemplateOptions(projectVars, {
      flow: 'fix-bug',
      platform: 'ios',
      runMode: 'autonomous',
      domain: 'perps',
    });
    const option = capability.options[0]!;
    const snapshot = readConfiguredExecutionTemplateSnapshot(projectVars, {
      flow: 'fix-bug',
      id: option.id,
      sourceId: option.sourceId,
      sha256: option.sha256,
    });

    assert.equal(snapshot.entry.sourceId, 'team:perps');
    assert.match(snapshot.markdown, /Validate the issue/);
    assert.throws(
      () =>
        readConfiguredExecutionTemplateSnapshot(projectVars, {
          flow: 'fix-bug',
          id: option.id,
          sourceId: option.sourceId,
          sha256: 'stale',
        }),
      /changed after catalog resolution/,
    );
  });
});

test('slot resolution uses explicit domain before the slot or pool default', () => {
  withProject((projectVars) => {
    const fromSlotDefault = resolveConfiguredExecutionTemplateForSlot(projectVars, {
      flow: 'fix-bug',
      platform: 'ios',
      runMode: 'autonomous',
      slotDomain: 'perps',
    });
    const fromExplicitDomain = resolveConfiguredExecutionTemplateForSlot(projectVars, {
      flow: 'fix-bug',
      platform: 'ios',
      runMode: 'autonomous',
      explicitDomain: 'perps',
      slotDomain: 'money-movement',
    });

    assert.equal(fromSlotDefault.effectiveDomain, 'perps');
    assert.equal(fromExplicitDomain.effectiveDomain, 'perps');
    assert.equal(fromExplicitDomain.reference.sha256, fromSlotDefault.reference.sha256);
  });
});
