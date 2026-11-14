import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executionTemplateReference } from '@farmslot/agent-runtime';

import { farmslotRoot, loadProjectVars } from '../../core/config.js';
import { proofInputFixture } from '../../evals/first-output.test-support.js';
import { writeResultPackageManifest } from '../../evals/package-store.js';
import { admitProofQa } from '../../evals/proof-profile.js';
import { makeEvalResultPackage } from '../../run-engine/test-fixtures.js';
import {
  configuredExecutionTemplateOptions,
  readConfiguredExecutionTemplateSnapshot,
  resolveConfiguredExecutionTemplateForSlot,
} from '../../tasks/execution-template-catalog.js';

import { resolveCandidateTemplateProvenance } from './candidate-setup.js';

test('catalog eval resolves the configured fix-bug default before a slot is assigned', async (t) => {
  const name = `eval-nested-catalog-${process.pid}-farm`;
  const root = path.join(farmslotRoot(), 'projects', name);
  await mkdir(path.join(root, 'catalog/fix-bug'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({
      name,
      execution_templates: {
        sources: [{ id: 'package:synthetic', kind: 'package', root: { projectPath: 'catalog' } }],
        defaults: [{ when: { flow: 'fix-bug' }, templateId: 'fix-bug/variant' }],
      },
    }),
  );
  const content =
    '---\nplatforms: [ios]\n---\n\n# Synthetic variant\n\n- [ ] Check the example behavior.\n';
  await writeFile(path.join(root, 'catalog/fix-bug/variant.md'), content);
  await writeFile(
    path.join(root, 'catalog/fix-bug/alternate.md'),
    '# Synthetic alternate\n\n- [ ] Check the alternate behavior.\n',
  );

  const result = await resolveCandidateTemplateProvenance(name, 'fix-bug', {});
  assert.equal(result.executionTemplate?.relativePath, 'fix-bug/variant.md');
  assert.equal(result.executionTemplate?.sourceId, 'package:synthetic');
  assert.equal(result.templateContent, content);
  assert.equal(result.provenance?.contentHash, result.executionTemplate?.sha256);
  assert.equal(result.provenance?.templateName, 'fix-bug/variant.md');
  assert.equal(result.provenance?.source, 'external');
  assert.equal(result.axes.template?.path, 'fix-bug/variant.md');
  assert.equal(result.mode, 'autonomous');

  for (const selection of ['fix-bug/alternate.md', 'templates/worker/alternate.md']) {
    const explicit = await resolveCandidateTemplateProvenance(name, 'fix-bug', {
      template: { path: selection },
    });
    assert.equal(explicit.executionTemplate?.relativePath, 'fix-bug/alternate.md');
    assert.equal(explicit.axes.template?.path, selection);
  }

  await mkdir(path.join(root, 'catalog/other'), { recursive: true });
  await writeFile(
    path.join(root, 'catalog/other/alternate.md'),
    '---\nid: fix-bug/other\nflow: fix-bug\n---\n\n# Synthetic duplicate\n\n- [ ] Check another behavior.\n',
  );
  const exact = await resolveCandidateTemplateProvenance(name, 'fix-bug', {
    template: { path: 'fix-bug/alternate.md' },
  });
  assert.equal(exact.executionTemplate?.relativePath, 'fix-bug/alternate.md');
  await assert.rejects(
    resolveCandidateTemplateProvenance(name, 'fix-bug', {
      template: { path: 'alternate.md' },
    }),
    /Candidate template path is ambiguous: alternate\.md.*fix-bug\/alternate\.md.*other\/alternate\.md/,
  );
  await assert.rejects(
    resolveCandidateTemplateProvenance(name, 'fix-bug', {
      template: { path: 'missing.md' },
    }),
    /Candidate template is unavailable in the project catalog: missing\.md/,
  );
});

test('catalog eval rejects a repeated strategy when package bytes change', async (t) => {
  const name = `eval-repeat-catalog-${process.pid}-farm`;
  const root = path.join(farmslotRoot(), 'projects', name);
  await mkdir(path.join(root, 'catalog/fix-bug'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({
      name,
      execution_templates: {
        sources: [{ id: 'package:synthetic', kind: 'package', root: { projectPath: 'catalog' } }],
        defaults: [{ when: { flow: 'fix-bug' }, templateId: 'fix-bug/mobile' }],
      },
    }),
  );
  const file = path.join(root, 'catalog/fix-bug/mobile.md');
  const content = '# Mobile fix\n\n- [ ] Check the example behavior.\n';
  await writeFile(file, content);
  // Serialized Command Center default trialStartParams.axes: no explicit template axis.
  const launchAxes = {
    prompt: { name: 'fix-bug' },
    harness: { name: 'recipe-harness' },
    review: { name: 'none', version: 'first-pass' },
    runner: { name: 'codex' },
    model: { name: 'comparison-model' },
  };
  const first = await resolveCandidateTemplateProvenance(name, 'fix-bug', launchAxes);
  assert.equal(first.executionTemplate?.relativePath, 'fix-bug/mobile.md');
  const repeated = await resolveCandidateTemplateProvenance(name, 'fix-bug', first.axes);
  assert.equal(repeated.templateContent, content);
  assert.equal(repeated.axes.template?.hash, repeated.executionTemplate?.sha256);
  assert.equal(repeated.axes.template?.hash, repeated.provenance?.contentHash);
  const padded = await resolveCandidateTemplateProvenance(name, 'fix-bug', {
    ...first.axes,
    template: { ...first.axes.template, hash: ` ${first.axes.template?.hash} ` },
  });
  assert.equal(padded.axes.template?.hash, repeated.provenance?.contentHash);
  const blank = await resolveCandidateTemplateProvenance(name, 'fix-bug', {
    template: { hash: ' ' },
  });
  assert.equal(blank.axes.template?.hash, repeated.provenance?.contentHash);
  await writeFile(file, content + '\nChanged package bytes.\n');
  await assert.rejects(
    resolveCandidateTemplateProvenance(name, 'fix-bug', first.axes),
    /Candidate template hash mismatch.*expected.*resolved/,
  );
  const refreshed = await resolveCandidateTemplateProvenance(name, 'fix-bug', launchAxes);
  assert.notEqual(refreshed.axes.template?.hash, first.axes.template?.hash);
  assert.equal(refreshed.axes.template?.hash, refreshed.provenance?.contentHash);
});

test('catalog eval rejects an old project-owned default hash after a package transition', async (t) => {
  const name = `eval-transition-catalog-${process.pid}-farm`;
  const root = path.join(farmslotRoot(), 'projects', name);
  await mkdir(path.join(root, 'templates/worker'), { recursive: true });
  await mkdir(path.join(root, 'catalog/fix-bug'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({
      name,
      execution_templates: {
        sources: [{ id: 'package:synthetic', kind: 'package', root: { projectPath: 'catalog' } }],
      },
    }),
  );
  const owned = path.join(root, 'templates/worker/fix-bug.md');
  await writeFile(owned, '# Project fix\n\n- [ ] Check the project behavior.\n');
  const first = await resolveCandidateTemplateProvenance(name, 'fix-bug', {
    template: { path: 'templates/worker/fix-bug.md' },
  });
  assert.equal(first.provenance?.source, 'current-project');
  await unlink(owned);
  await writeFile(
    path.join(root, 'catalog/fix-bug/core.md'),
    '---\nid: fix-bug/default\nflow: fix-bug\n---\n\n# Package fix\n\n- [ ] Check package behavior.\n',
  );
  await assert.rejects(
    resolveCandidateTemplateProvenance(name, 'fix-bug', first.axes),
    /Candidate template is unavailable in the project catalog: templates\/worker\/fix-bug\.md/,
  );
  await assert.rejects(
    resolveCandidateTemplateProvenance(name, 'fix-bug', {
      template: { hash: first.axes.template?.hash },
    }),
    /Candidate template hash mismatch.*expected.*resolved/,
  );
  const current = await resolveCandidateTemplateProvenance(name, 'fix-bug', {});
  assert.equal(current.provenance?.source, 'external');
  assert.equal(current.axes.template?.hash, current.provenance?.contentHash);
});

test('catalog eval preserves the project-owned fix-bug default', async (t) => {
  const name = `eval-owned-catalog-${process.pid}-farm`;
  const root = path.join(farmslotRoot(), 'projects', name);
  await mkdir(path.join(root, 'templates/worker'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({ name, execution_templates: { sources: [] } }),
  );
  await writeFile(
    path.join(root, 'templates/worker/fix-bug.md'),
    '# Synthetic fix\n\n- [ ] Check the example behavior.\n',
  );
  const result = await resolveCandidateTemplateProvenance(name, 'fix-bug', {});
  assert.equal(result.executionTemplate?.relativePath, 'fix-bug.md');
  assert.equal(result.provenance?.source, 'current-project');
  assert.equal(result.provenance?.templateIsDefault, true);
  assert.equal(result.mode, 'autonomous');
});

test('catalog eval keeps a selected local variant and its exact template snapshot', async (t) => {
  const name = `eval-catalog-${process.pid}-farm`;
  const root = path.join(farmslotRoot(), 'projects', name);
  await mkdir(path.join(root, 'templates/worker'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({ name, execution_templates: { sources: [] } }),
  );
  const content =
    '---\nid: dev/treatment\nflow: dev\n---\n\n# Treatment\n\n- [ ] Validate the candidate.\n';
  await writeFile(path.join(root, 'templates/worker/dev-treatment.md'), content);
  const result = await resolveCandidateTemplateProvenance(name, 'dev', {
    template: { path: 'templates/worker/dev-treatment.md' },
    model: { name: 'comparison-model' },
  });
  assert.equal(result.executionTemplate?.id, 'dev/treatment');
  assert.equal(result.executionTemplate?.sha256, result.provenance?.contentHash);
  assert.equal(result.templateContent, content);
  assert.equal(result.taskTemplate, undefined);
  assert.equal(result.mode, 'interactive');
  assert.equal(result.axes.model?.name, 'comparison-model');
  assert.equal(result.axes.template?.path, 'templates/worker/dev-treatment.md');
});

test('model-only dev comparison preserves autonomous mode and the interactive axis remains interactive', async () => {
  const automatic = await resolveCandidateTemplateProvenance('farmslot-farm', 'dev', {
    model: { name: 'comparison-model' },
  });
  assert.equal(automatic.executionTemplate?.id, 'dev/default');
  assert.equal(automatic.mode, 'autonomous');
  const interactive = await resolveCandidateTemplateProvenance('farmslot-farm', 'dev', {
    template: { path: 'templates/worker/dev-interactive.md' },
  });
  assert.equal(interactive.executionTemplate?.id, 'dev/interactive');
  assert.equal(interactive.mode, 'interactive');
});

test('proof trials retain a package template admitted by the farm QA preset', async (t) => {
  const name = `proof-package-${process.pid}-farm`;
  const root = path.join(farmslotRoot(), 'projects', name);
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), 'proof-template-package-'));
  const variable = 'FARMSLOT_TEST_PROOF_PACKAGE_ROOT';
  const previousRoot = process.env[variable];
  process.env[variable] = packageRoot;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env[variable];
    else process.env[variable] = previousRoot;
    await rm(root, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(packageRoot, 'checklists/qa'), { recursive: true });
  await mkdir(path.join(root, 'templates/worker'), { recursive: true });
  const markdown =
    '---\nid: qa/default\nflow: qa\nplatforms: [cli]\n---\n\n# QA\n\n- [ ] Record observed proof.\n';
  await writeFile(path.join(packageRoot, 'checklists/qa/default.md'), markdown);
  await writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({
      name,
      qa: { profiles: [{ id: 'pr', title: 'PR QA', template_id: 'qa/default' }] },
      execution_templates: {
        sources: [
          {
            id: 'package:canonical',
            kind: 'package',
            root: { env: variable },
            subpath: 'checklists',
          },
        ],
      },
    }),
  );
  const vars = await loadProjectVars(name);
  const catalog = await configuredExecutionTemplateOptions(vars, {
    flow: 'qa',
    explicitId: 'qa/default',
  });
  const entry = catalog.options.find((option) => option.id === 'qa/default');
  assert.ok(entry);
  assert.equal(entry.sourceKind, 'package');
  const snapshot = await readConfiguredExecutionTemplateSnapshot(vars, { ...entry, flow: 'qa' });
  const admitted = await admitProofQa({
    project: name,
    taskProfile: 'proof',
    source: { kind: 'git-ref', ref: 'main' },
    qaProfileId: 'pr',
  });
  assert.deepEqual(admitted.executionTemplate, executionTemplateReference(snapshot.entry));
  const proof = { ...proofInputFixture(), ...admitted };
  const result = await resolveCandidateTemplateProvenance(name, 'proof', {}, proof);
  assert.deepEqual(result.executionTemplate, proof.executionTemplate);
  assert.equal(result.templateContent, markdown);
  assert.equal(result.provenance?.source, 'external');
  assert.deepEqual(result.provenance?.executionTemplate, proof.executionTemplate);
  const stored = await writeResultPackageManifest(
    path.join(packageRoot, 'candidate.json'),
    makeEvalResultPackage({
      taskProfile: 'proof',
      proof,
      axes: result.axes,
      templateProvenance: result.provenance,
    }),
  );
  assert.equal(stored.templateProvenance?.templatePath, proof.executionTemplate.relativePath);
  await assert.rejects(
    resolveCandidateTemplateProvenance(
      name,
      'proof',
      { template: { hash: 'f'.repeat(64) } },
      proof,
    ),
    /cannot override/,
  );
  await writeFile(
    path.join(packageRoot, 'checklists/qa/default.md'),
    markdown + '\nChanged package bytes.\n',
  );
  await assert.rejects(
    resolveCandidateTemplateProvenance(name, 'proof', {}, proof),
    /changed|hash|digest|snapshot/i,
  );
});

test('trial-local snapshot leaves the live catalog and default unchanged', async (t) => {
  const name = `eval-local-${process.pid}-farm`;
  const root = path.join(farmslotRoot(), 'projects', name);
  const experiment = await mkdtemp(path.join(os.tmpdir(), 'eval-local-source-'));
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(experiment, { recursive: true, force: true }),
    ]),
  );
  await mkdir(path.join(root, 'templates/worker'), { recursive: true });
  await writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({ name, execution_templates: { sources: [] } }),
  );
  await writeFile(
    path.join(root, 'templates/worker/fix-bug.md'),
    '# Live default\n\n- [ ] Keep live behavior.\n',
  );
  const source = path.join(experiment, 'B1.core.md');
  const markdown = '# Trial B1\n\n- [ ] Use the local candidate.\n';
  await writeFile(source, markdown);
  const vars = await loadProjectVars(name);
  const query = { flow: 'fix-bug', platform: 'core', runMode: 'autonomous' as const };
  const before = await configuredExecutionTemplateOptions(vars, query);
  const live = await resolveConfiguredExecutionTemplateForSlot(vars, query);
  const candidate = await resolveCandidateTemplateProvenance(
    name,
    'fix-bug',
    {},
    undefined,
    source,
  );
  assert.equal(candidate.templateContent, markdown);
  assert.equal(candidate.executionTemplate?.sourceId, 'eval-candidate');
  assert.deepEqual(candidate.executionTemplate?.platforms, ['core']);
  assert.equal(candidate.axes.template?.hash, candidate.provenance?.contentHash);
  assert.ok(candidate.executionTemplate);
  const snapshot = path.join(experiment, 'candidate-template.md');
  await writeFile(snapshot, markdown);
  await unlink(source);
  const frozen = { path: snapshot, reference: candidate.executionTemplate };
  const selected = await resolveConfiguredExecutionTemplateForSlot(vars, {
    ...query,
    candidateTemplate: frozen,
  });
  assert.equal(
    selected.markdown,
    markdown,
    'Task writing uses the frozen bytes after the original file is removed.',
  );
  assert.equal(selected.reference.sha256, candidate.axes.template?.hash);
  assert.deepEqual(selected.reference.platforms, ['core']);
  assert.deepEqual(await configuredExecutionTemplateOptions(vars, query), before);
  assert.deepEqual(await resolveConfiguredExecutionTemplateForSlot(vars, query), live);
  await assert.rejects(
    resolveConfiguredExecutionTemplateForSlot(vars, {
      ...query,
      platform: 'ios',
      candidateTemplate: frozen,
    }),
    /incompatible/,
  );
  await writeFile(snapshot, markdown + 'Changed.');
  await assert.rejects(
    resolveConfiguredExecutionTemplateForSlot(vars, { ...query, candidateTemplate: frozen }),
    /hash mismatch/,
  );
  await writeFile(source, markdown);
  await assert.rejects(
    resolveCandidateTemplateProvenance(
      name,
      'fix-bug',
      { template: { hash: 'f'.repeat(64) } },
      undefined,
      source,
    ),
    /hash mismatch/,
  );
  await assert.rejects(
    resolveCandidateTemplateProvenance(name, 'proof', {}, undefined, source),
    /Proof template cannot override/,
  );
});
