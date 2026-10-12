import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { nativeWorkerLaunchDigest } from '@farmslot/agent-runtime/native/worker-launch';
import type { SourceLock, SourceMaterialization } from '@farmslot/protocol';
import {
  freezePlannedRunSources,
  sourceWorkerEnvironment,
  withProjectSources,
} from '@farmslot/slot-config';
import { sourceLockDigest } from '@farmslot/slot-config/sources';

import { withProjectMachineEnv } from '../core/project-env.js';
import { buildLaunchCommand } from '../runners/launch-command.js';
import { makeVars } from '../runners/test-fixtures.js';

import { assertRetainedSourceInputs } from './runtime.js';

function materialization(commit = 'a'.repeat(40)): SourceMaterialization {
  const content: Omit<SourceLock, 'digest'> = {
    schemaVersion: 1,
    context: { project: 'demo' },
    generation: 1,
    declarationRevision: 1,
    pinRevision: 0,
    resolvedAt: '2026-10-12T00:00:00.000Z',
    packBindings: { demo: { sourceId: 'pack', entry: '.' } },
    entries: [
      {
        sourceId: 'pack',
        kind: 'pack',
        repo: 'https://example.test/owner/demo',
        declaredRef: 'main',
        effectiveRef: 'main',
        commit,
        objectFormat: 'sha1',
        treeDigest: 'b'.repeat(64),
        resolutionGeneration: 1,
        scope: 'farm',
        dependencies: [],
      },
    ],
  };
  const lock = { ...content, digest: sourceLockDigest(content) };
  return {
    lock,
    roots: { pack: '/immutable/pack' },
    receiptPath: `/receipts/${lock.digest}.json`,
    receipt: {
      schemaVersion: 1,
      id: 'receipt',
      nodeId: 'node',
      lockDigest: lock.digest,
      verifiedAt: content.resolvedAt,
      sources: [],
    },
  };
}

function inputs(value: SourceMaterialization) {
  return {
    project: 'demo',
    pack: value.lock.packBindings.demo,
    materialization: value,
    execution: value,
    workerExecution: value,
    packs: value.lock.packBindings,
  };
}

test('terminal runner command exports the admitted worker inputs inside the launch shell', () => {
  const value = materialization();
  const command = withProjectSources(inputs(value), () =>
    buildLaunchCommand(makeVars(), 'claude', 'sonnet', 'do work', { claudeUsesDispatchCmd: false }),
  );
  assert.ok(command.includes(`export FARMSLOT_SOURCE_RECEIPT='${value.receiptPath}'`));
  assert.ok(
    command.indexOf('export FARMSLOT_SOURCE_RECEIPT=') < command.indexOf('/usr/local/bin/claude'),
  );
  assert.ok(command.includes(`export FARMSLOT_SOURCE_LOCK_DIGEST='${value.lock.digest}'`));
});

test('direct command routing keeps runtime source receipts after project and pool overrides', () => {
  const value = materialization();
  const command = withProjectSources(inputs(value), () =>
    withProjectMachineEnv(
      `printf '%s' "$FARMSLOT_SOURCE_RECEIPT"`,
      makeVars({ machineEnv: { FARMSLOT_SOURCE_RECEIPT: '/loose/pool' } }),
      { command_env: { unset: ['FARMSLOT_SOURCE_RECEIPT'] } },
    ),
  );
  assert.equal(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }), value.receiptPath);
});

test('run ownership changes preserve native launch identity; changed source inputs refuse retained reuse', () => {
  const value = materialization();
  const sources = inputs(value);
  const before = withProjectSources(sources, () => freezePlannedRunSources('before')!);
  const after = withProjectSources(sources, () => freezePlannedRunSources('after')!);
  assert.notEqual(before.lock.digest, after.lock.digest);
  const digest = (lock: SourceLock) =>
    nativeWorkerLaunchDigest({
      leaseId: 'lease',
      safetyTier: 'full-auto',
      environment: {
        unset: [],
        set: sourceWorkerEnvironment({
          ...sources,
          execution: { ...value, lock, receiptPath: `/receipts/${lock.digest}.json` },
        }),
      },
    });
  assert.equal(digest(before.lock), digest(after.lock));
  assert.doesNotThrow(() =>
    assertRetainedSourceInputs({ sourceProvenance: before }, { sourceProvenance: after }),
  );
  const changed = withProjectSources(
    inputs(materialization('c'.repeat(40))),
    () => freezePlannedRunSources('changed')!,
  );
  assert.throws(
    () => assertRetainedSourceInputs({ sourceProvenance: before }, { sourceProvenance: changed }),
    /inputs changed/,
  );
  assert.throws(
    () => assertRetainedSourceInputs(undefined, { sourceProvenance: after }),
    /unknown/,
  );
  assert.throws(() => assertRetainedSourceInputs({ sourceProvenance: before }, {}), /unknown/);
  assert.doesNotThrow(() => assertRetainedSourceInputs(undefined, {}));
  assert.equal(before.workerLock.entries[0].commit, 'a'.repeat(40));
});

test('worker prompts use the inherited pack in the admitted closure and never resolve a floating fallback', async (t) => {
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { configureProjectSources } = await import('@farmslot/slot-config');
  const { resolveWorkerDispatchPrompt } = await import('../runners/worker-prompt.js');
  const root = await mkdtemp(path.join(tmpdir(), 'source-prompt-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'demo'), { recursive: true });
  await mkdir(path.join(root, 'shared/templates/prompts'), { recursive: true });
  await writeFile(
    path.join(root, 'shared/templates/prompts/worker-dispatch.md'),
    'Locked dispatch: {{TASK_FILE}}',
  );
  const value = materialization();
  value.roots.pack = root;
  value.lock.packBindings = {
    demo: { sourceId: 'pack', entry: 'demo' },
    'farmslot-farm': { sourceId: 'pack', entry: 'shared' },
  };
  const { digest: _, ...content } = value.lock;
  value.lock.digest = sourceLockDigest(content);
  value.receipt.lockDigest = value.lock.digest;
  const sources = { ...inputs(value), pack: value.lock.packBindings.demo };
  let floatingReads = 0;
  configureProjectSources(
    async () => {
      floatingReads++;
      throw new Error('floating source read');
    },
    () => ['demo'],
  );
  const prompt = await withProjectSources(sources, () =>
    resolveWorkerDispatchPrompt('demo', { taskFile: 'TASK.md' }),
  );
  assert.equal(prompt, 'Locked dispatch: TASK.md');
  delete value.lock.packBindings['farmslot-farm'];
  await assert.rejects(
    withProjectSources(sources, () => resolveWorkerDispatchPrompt('demo', { taskFile: 'TASK.md' })),
    /outside the admitted source closure/,
  );
  assert.equal(floatingReads, 0);
});

test('review and fix templates use locked pack bytes and bound paths while legacy CI keeps its default', async (t) => {
  const { mkdir, mkdtemp, readFile, realpath, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { withLegacyProjectSources, loadProjectVars, invalidateProjectVarsCache } =
    await import('@farmslot/slot-config');
  const { projectWorkerTemplatePath } = await import('../core/worker-templates.js');
  const { expandTemplateWithReservedLast } = await import('../core/hooks.js');
  const { expandReviewTemplate } = await import('../review/templates.js');
  const { resolveCiFixTemplatePath } = await import('../ci-monitor/inline-fix.js');
  const { createRun, deleteRun, updateRun } = await import('../runs/store.js');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'locked-review-templates-')));
  t.after(async () => {
    invalidateProjectVarsCache('demo');
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'templates/worker'), { recursive: true });
  await writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({ name: 'demo', ci: { local_check: 'true' } }),
  );
  for (const name of ['review.md', 'review-fix.md', 'ci-fix.md'])
    await writeFile(
      path.join(root, 'templates/worker', name),
      `# Locked ${name}\n{{farmslot_dir}}/projects/demo/fixtures/check {{CI_PARITY_STEP}}\n`,
    );
  const value = materialization();
  value.roots.pack = root;
  const sources = inputs(value);
  await withProjectSources(sources, async () => {
    const vars = makeVars({ projectName: 'demo', remoteRepo: root });
    const pv = await loadProjectVars('demo');
    for (const name of ['review.md', 'review-fix.md', 'ci-fix.md']) {
      const file = await projectWorkerTemplatePath('demo', name);
      assert.equal(file, path.join(root, 'templates/worker', name));
      const raw = await readFile(file, 'utf8');
      const rendered = expandTemplateWithReservedLast(raw, vars, pv, {
        TASK_DIR: 'tasks/demo',
        CI_PARITY_CHECKLIST: 'CHECKLIST.md',
      });
      assert.ok(rendered.includes(`${root}/fixtures/check`));
      assert.ok(!rendered.includes('/projects/demo/'));
    }
    assert.equal(
      await resolveCiFixTemplatePath('demo'),
      path.join(root, 'templates/worker/ci-fix.md'),
    );
    const run = createRun({
      flowType: 'dev',
      mode: 'autonomous',
      project: 'demo',
      ticketOrPr: 'TEST-LOCKED-REVIEW',
    });
    try {
      await writeFile(
        path.join(root, 'templates/worker/review.md'),
        '# Locked review\n{{FARMSLOT_DIR}}/projects/demo/fixtures/check\n',
      );
      const rendered = await expandReviewTemplate(vars, 'tasks/demo', run.id, 'static-code');
      assert.ok(rendered.startsWith(`# Locked review\n${root}/fixtures/check`));
    } finally {
      updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
    await rm(path.join(root, 'templates/worker/ci-fix.md'));
    await assert.rejects(
      resolveCiFixTemplatePath('demo'),
      /Locked pack demo has no declared CI fix default/,
    );
    const frameworkRoot = path.join(root, 'framework');
    await mkdir(path.join(frameworkRoot, 'templates/worker'), { recursive: true });
    const defaultFile = path.join(frameworkRoot, 'templates/worker/ci-fix.md');
    await writeFile(defaultFile, '# Locked framework default');
    const complete = structuredClone(value);
    complete.roots.framework = frameworkRoot;
    complete.lock.entries.push({ ...complete.lock.entries[0], sourceId: 'framework' });
    complete.lock.packBindings['farmslot-farm'] = { sourceId: 'framework', entry: '.' };
    const { digest: _, ...content } = complete.lock;
    complete.lock.digest = sourceLockDigest(content);
    complete.receipt.lockDigest = complete.lock.digest;
    await withProjectSources(inputs(complete), async () => {
      assert.equal(await resolveCiFixTemplatePath('demo'), defaultFile);
    });
  });
  const legacy = await withLegacyProjectSources('missing', () =>
    resolveCiFixTemplatePath('missing'),
  );
  assert.ok(legacy?.endsWith('/templates/worker/ci-fix.md'));
});
