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
    // Entry-label gate inside a general source: hidden by domain filtering
    // even though the source itself always participates.
    writeFileSync(
      path.join(templatesDir, 'worker', 'fix-bug-mm.md'),
      `---
labels: [domain:money-movement]
runMode: autonomous
platforms: [ios]
---

# Money-movement proof

- [ ] Validate settlement.
`,
    );
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
    // The requested perps domain still hides the money-movement entry-labelled
    // project template; only fully-matching queries report nothing filtered.
    assert.deepEqual(capability.filteredSources, [
      {
        id: 'project:example-farm',
        reason: 'domain-restricted',
        domains: ['money-movement'],
      },
    ]);

    // Without a domain both gates must surface loudly — the source-level perps
    // drop AND the entry-label money-movement drop — instead of vanishing.
    const noDomain = configuredExecutionTemplateOptions(projectVars, {
      flow: 'fix-bug',
      platform: 'ios',
      runMode: 'autonomous',
    });
    assert.deepEqual(noDomain.filteredSources, [
      {
        id: 'project:example-farm',
        reason: 'domain-restricted',
        domains: ['money-movement'],
      },
      { id: 'team:perps', reason: 'domain-restricted', domains: ['perps'] },
    ]);
    assert.equal(
      noDomain.options.some((option) => option.sourceId === 'team:perps'),
      false,
    );

    // A query matching every gate reports an empty filtered list.
    const moneyMovement = configuredExecutionTemplateOptions(projectVars, {
      flow: 'fix-bug',
      platform: 'ios',
      runMode: 'autonomous',
      domain: 'money-movement',
    });
    assert.deepEqual(moneyMovement.filteredSources, [
      { id: 'team:perps', reason: 'domain-restricted', domains: ['perps'] },
    ]);
    assert.equal(
      moneyMovement.options.some((option) => option.id === 'fix-bug/mm'),
      true,
    );
    assert.deepEqual(
      moneyMovement.options.find((option) => option.id === 'fix-bug/perps-mobile'),
      undefined,
    );

    const unfiltered = configuredExecutionTemplateOptions(projectVars, { unfiltered: true });
    const unfilteredIds = unfiltered.options.map((option) => option.id).sort();
    assert.ok(unfilteredIds.includes('fix-bug/perps-mobile'));
    assert.ok(unfilteredIds.includes('fix-bug/mm'));
    assert.deepEqual(
      unfiltered.options.find((option) => option.sourceId === 'team:perps')?.sourceDomains,
      ['perps'],
    );
    assert.deepEqual(unfiltered.filteredSources, []);
    assert.equal(unfiltered.defaults?.[0]?.templateId, 'fix-bug/perps-mobile');
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

test('configured preview can read an offered source shadowed outside the active domain', () => {
  withProject((projectVars) => {
    const root = path.dirname(projectVars.projectConfig);
    const canonicalRoot = path.join(root, 'canonical', 'checklists', 'fix-bug');
    mkdirSync(canonicalRoot, { recursive: true });
    writeFileSync(
      path.join(canonicalRoot, 'mobile.md'),
      `---
id: fix-bug/perps-mobile
runMode: autonomous
platforms: [ios]
---

# Canonical mobile proof

- [ ] Validate the canonical journey.
`,
    );
    (projectVars.projectJson.execution_templates!.sources ??= []).unshift({
      id: 'package:canonical',
      kind: 'package',
      root: { projectPath: 'canonical' },
      subpath: 'checklists',
    });

    const capability = configuredExecutionTemplateOptions(projectVars, {
      flow: 'fix-bug',
      platform: 'ios',
      runMode: 'autonomous',
    });
    const option = capability.options.find(
      (candidate) =>
        candidate.id === 'fix-bug/perps-mobile' && candidate.sourceId === 'package:canonical',
    );
    assert.ok(option);

    const snapshot = readConfiguredExecutionTemplateSnapshot(projectVars, {
      flow: 'fix-bug',
      id: option.id,
      sourceId: option.sourceId,
      sha256: option.sha256,
    });
    assert.equal(snapshot.entry.sourceId, 'package:canonical');
    assert.match(snapshot.markdown, /Validate the canonical journey/);
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
