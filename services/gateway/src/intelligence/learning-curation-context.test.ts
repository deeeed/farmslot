import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import '../runtime/mock-pty.test-support.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'curation-context-'));
Object.assign(process.env, {
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
});
const { createRun, getRun, updateRun, deleteRun } = await import('../runs/store.js');
const { retainRunFixture } = await import('../run-engine/test-fixtures.js');
const { loadLearningCurationContext } = await import('./learning-curation-context.js');
const { invalidateProjectVarsCache } = await import('@farmslot/slot-config');

test('curation reads configured shared/overlay rules and retained evidence after staging cleanup', async (t) => {
  const project = 'curation-source';
  const projectRoot = path.join(root, 'projects', project);
  const library = path.join(projectRoot, 'library/review');
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, 'antipatterns.md'), '# Shared\nExisting check.');
  await writeFile(
    path.join(library, 'antipatterns.terminal.md'),
    '# Overlay\nExisting client check.',
  );
  await writeFile(
    path.join(projectRoot, 'project.json'),
    JSON.stringify({
      name: project,
      static_review: {
        support: { libraries: [{ name: 'team', root: { projectPath: 'library' } }] },
      },
      reference_repos: { team_library: { repo_url: 'git@github.com:example/knowledge.git' } },
    }),
  );
  invalidateProjectVarsCache(project);
  const run = createRun({ project, flowType: 'fix-bug', ticketOrPr: 'SOURCE-1' });
  t.after(async () => {
    updateRun(run.id, { status: 'cancelled' });
    await deleteRun(run.id);
    await rm(root, { recursive: true, force: true });
  });
  const task = path.join(root, 'task');
  await mkdir(path.join(task, 'artifacts'), { recursive: true });
  await writeFile(path.join(task, 'TASK.md'), '# Test');
  await writeFile(path.join(task, 'artifacts/report.md'), 'Observed source failure.');
  await writeFile(
    path.join(task, 'artifacts/review-result.json'),
    JSON.stringify(
      {
        verdict: 'issues',
        issues: [
          {
            file: 'src/order.ts',
            line: 4,
            description: 'Independent reviewer confirms wrong order size',
            severity: 'major',
          },
        ],
      },
      null,
      2,
    ),
  );

  updateRun(run.id, {
    taskFile: path.join(task, 'TASK.md'),
    status: 'done',
    agentContexts: [
      {
        id: 'reviewer',
        label: 'Independent review',
        role: 'review',
        status: 'complete',
        runId: run.id,
        slotId: null,
        reviewResultFile: 'artifacts/review-result.json',
      },
    ],
  });
  const captured = getRun(run.id);
  assert(captured);
  await retainRunFixture(captured);
  await rm(task, { recursive: true });
  const destination = {
    repo: 'git@github.com:example/knowledge.git',
    path: 'review/antipatterns.md',
    source: 'static_review' as const,
  };
  const context = await loadLearningCurationContext(project, destination, run.id);
  assert.equal(context.unavailable, undefined);
  assert.equal(context.library.length, 2);
  assert.equal(
    context.evidence.find((d) => d.path === 'artifacts/report.md')?.text,
    'Observed source failure.',
  );
  assert.equal(
    context.evidence.find((d) => d.path === 'artifacts/review-result.json')?.confirms,
    'independent-review',
  );
  updateRun(run.id, { agentContexts: [] });
  const unownedContext = await loadLearningCurationContext(project, destination, run.id);
  const unowned = unownedContext.evidence.find((d) => d.path === 'artifacts/review-result.json');
  assert(unowned, 'review-shaped bytes are present without a recorded reviewer owner');
  assert.equal(
    unowned.confirms,
    undefined,
    'unowned worker files cannot supply reviewer confirmation',
  );

  const missing = await loadLearningCurationContext(
    project,
    { ...destination, repo: 'git@github.com:example/absent.git' },
    run.id,
  );
  assert.match(missing.unavailable ?? '', /no configured readable library source/);
});
