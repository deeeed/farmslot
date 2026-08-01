import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { farmslotRoot } from '../projects/repo-root.js';

const testDir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-backlog-refine-'));
const specRoot = path.join(farmslotRoot, '.sandbox', `backlog-refine-spec-${process.pid}`);
const promptRoot = path.join(farmslotRoot, '.sandbox', `backlog-refine-prompts-${process.pid}`);
process.env.FARMSLOT_BACKLOG_FILE = path.join(testDir, 'backlog.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = path.join(testDir, 'queue.json');
process.env.FARMSLOT_BACKLOG_SPEC_DIR = specRoot;
process.env.FARMSLOT_BACKLOG_REFINEMENT_PROMPT_DIR = promptRoot;

const execFileAsync = promisify(execFile);

test.after(async () => {
  const backlog = await import('./store.js');
  await backlog.flushBacklogForTests();
  await Promise.all([
    rm(testDir, { recursive: true, force: true }),
    rm(specRoot, { recursive: true, force: true }),
    rm(promptRoot, { recursive: true, force: true }),
  ]);
});

async function writeSpec(name: string, markdown: string): Promise<string> {
  await mkdir(path.join(specRoot, 'farmslot-farm'), { recursive: true });
  const absolutePath = path.join(specRoot, 'farmslot-farm', name);
  await writeFile(absolutePath, markdown, 'utf8');
  return path.relative(farmslotRoot, absolutePath);
}

async function fresh() {
  const backlog = await import('./store.js');
  const refinement = await import('./refinement.js');
  await backlog.flushBacklogForTests();
  backlog.initBacklogStore(() => {});
  await backlog.loadBacklog();
  return { backlog, refinement };
}

function lifecycleSnapshot(item: {
  status: string;
  sourceKind: string;
  sourceRef: string;
  runId?: string;
  queuedQueueItemId?: string;
  workGraphId?: string;
  workNodeId?: string;
  roadmapItemId?: string;
  shipped?: unknown;
}) {
  return {
    status: item.status,
    sourceKind: item.sourceKind,
    sourceRef: item.sourceRef,
    runId: item.runId ?? null,
    queuedQueueItemId: item.queuedQueueItemId ?? null,
    workGraphId: item.workGraphId ?? null,
    workNodeId: item.workNodeId ?? null,
    roadmapItemId: item.roadmapItemId ?? null,
    shipped: item.shipped ?? null,
  };
}

test('backlog refinement prepares prompt with bounded context and fs-backlog-spec contract', async () => {
  const { backlog, refinement } = await fresh();
  const specPath = await writeSpec(
    'refine-me.md',
    [
      '---',
      "kind: 'backlog-spec'",
      "project: 'farmslot-farm'",
      '---',
      '',
      '# Refine me',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] unit test `services/gateway/src/backlog/refinement.test.ts` passes',
      '',
      '## Non-goals',
      '',
      '- Do not auto-dispatch.',
      '',
    ].join('\n'),
  );
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Refine backlog contract',
    sourceKind: 'manual',
    flowType: 'dev',
    notes: 'Operator notes for refinement',
    specPath,
    roadmapItemId: 'ri_linked',
    runner: 'claude',
    model: 'sonnet',
    priority: 5,
    tags: ['refinement'],
  });

  const result = await refinement.startBacklogRefinement({
    itemId: created.item.id,
    launch: false,
    runner: 'codex',
    model: 'gpt-5.6-sol',
  });

  assert.equal(result.launched, false);
  assert.equal(result.runner, 'codex');
  assert.equal(result.model, 'gpt-5.6-sol');
  assert.equal(result.tmuxSession, `backlog-${created.item.sourceRef.toLowerCase()}`);
  assert.match(result.promptPath, /backlog-refine-prompts-\d+\//);

  const prompt = await readFile(path.join(farmslotRoot, result.promptPath), 'utf8');
  assert.match(prompt, /## Item identity/);
  assert.match(prompt, new RegExp(`id: ${created.item.id}`));
  assert.match(prompt, new RegExp(`project: ${created.item.project}`));
  assert.match(prompt, new RegExp(`sourceRef: ${created.item.sourceRef}`));
  assert.match(prompt, /Operator notes for refinement/);
  assert.match(prompt, /## Attached spec/);
  assert.match(prompt, /unit test `services\/gateway\/src\/backlog\/refinement\.test\.ts`/);
  assert.match(prompt, /## Dispatch settings/);
  assert.match(prompt, /runner: claude/);
  assert.match(prompt, /## Linked roadmap \/ work-graph \/ run context/);
  assert.match(prompt, /roadmapItemId: ri_linked/);
  assert.match(prompt, /fs-backlog-spec/);
  assert.match(prompt, /Do \*\*not\*\* promote roadmap drafts/);
  assert.match(prompt, /Do \*\*not\*\* change roadmap item stages/);
  assert.doesNotMatch(prompt, /update the roadmap item frontmatter to `stage: "refined"`/);
});

test('backlog refinement preserves source identity for manual and external items', async () => {
  const { backlog, refinement } = await fresh();
  const manualSpec = await writeSpec(
    'manual.md',
    ['# Manual', '', '## Acceptance Criteria', '', '- [ ] ok `test`', '', '## Non-goals', '', '- n/a', ''].join(
      '\n',
    ),
  );
  const manual = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Manual with spec',
    sourceKind: 'manual',
    flowType: 'dev',
    specPath: manualSpec,
  });
  const external = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'External jira',
    sourceKind: 'jira',
    sourceRef: 'TAT-4242',
    flowType: 'fix-bug',
  });

  const beforeManual = lifecycleSnapshot(manual.item);
  const beforeExternal = lifecycleSnapshot(external.item);

  const refinedManual = await refinement.startBacklogRefinement({
    itemId: manual.item.id,
    launch: false,
  });
  const refinedExternal = await refinement.startBacklogRefinement({
    itemId: external.item.id,
    launch: false,
  });

  assert.deepEqual(lifecycleSnapshot(refinedManual.item), beforeManual);
  assert.deepEqual(lifecycleSnapshot(refinedExternal.item), beforeExternal);
  assert.equal(refinedManual.item.sourceKind, 'manual');
  assert.equal(refinedExternal.item.sourceKind, 'jira');
  assert.equal(refinedExternal.item.sourceRef, 'TAT-4242');
});

test('backlog refinement reuses one existing tmux session instead of creating a second', async () => {
  const { backlog, refinement } = await fresh();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Session reuse',
    sourceKind: 'manual',
    flowType: 'dev',
  });
  const session = refinement.__backlogRefinementTest.backlogRefinementSessionName(created.item);
  try {
    await execFileAsync('tmux', ['kill-session', '-t', `=${session}`]).catch(() => undefined);
  } catch {
    // session may not exist
  }

  const first = await refinement.startBacklogRefinement({
    itemId: created.item.id,
    launch: true,
    runnerCommand: "bash -lc 'exec sleep 120'",
  });
  assert.equal(first.launched, true);
  assert.equal(first.attachedExisting, undefined);

  const second = await refinement.startBacklogRefinement({
    itemId: created.item.id,
    launch: true,
    runnerCommand: "bash -lc 'exec sleep 120'",
  });
  assert.equal(second.launched, false);
  assert.equal(second.attachedExisting, true);
  assert.equal(second.tmuxSession, first.tmuxSession);

  const sessionStatus = await refinement.getBacklogRefinementSession({ itemId: created.item.id });
  assert.equal(sessionStatus.exists, true);
  assert.equal(sessionStatus.tmuxSession, first.tmuxSession);

  await execFileAsync('tmux', ['kill-session', '-t', `=${session}`]);
});

test('completing or reopening refinement does not mutate lifecycle or linkage', async () => {
  const { backlog, refinement } = await fresh();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Stable lifecycle',
    sourceKind: 'manual',
    flowType: 'dev',
    roadmapItemId: 'ri_keep',
  });
  // Simulate linkage fields that refinement must never touch.
  await backlog.updateBacklogItem({
    itemId: created.item.id,
    notes: 'linked context',
  });
  const ready = await backlog.markBacklogItemReady({ itemId: created.item.id });
  const before = lifecycleSnapshot(ready.item);

  const prepared = await refinement.startBacklogRefinement({
    itemId: ready.item.id,
    launch: false,
  });
  assert.deepEqual(lifecycleSnapshot(prepared.item), before);

  const session = refinement.__backlogRefinementTest.backlogRefinementSessionName(ready.item);
  try {
    await execFileAsync('tmux', ['kill-session', '-t', `=${session}`]).catch(() => undefined);
  } catch {
    // ignore
  }
  const launched = await refinement.startBacklogRefinement({
    itemId: ready.item.id,
    launch: true,
    runnerCommand: "bash -lc 'exec sleep 60'",
  });
  assert.deepEqual(lifecycleSnapshot(launched.item), before);
  const reopened = await refinement.startBacklogRefinement({
    itemId: ready.item.id,
    launch: true,
    runnerCommand: "bash -lc 'exec sleep 60'",
  });
  assert.deepEqual(lifecycleSnapshot(reopened.item), before);
  await execFileAsync('tmux', ['kill-session', '-t', `=${session}`]).catch(() => undefined);
});

test('backlog refinement shell prelude clears ambient tmux and scopes the runner', async () => {
  const { backlog, refinement } = await fresh();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Prelude check',
    sourceKind: 'manual',
    flowType: 'dev',
  });
  const command = refinement.__backlogRefinementTest.buildBacklogRefinementShellCommand(
    created.item,
    '.backlog/refinement-prompts/example.md',
    '{{runner}} --model {{model}} refine {{prompt_path}} --item {{item_file}}',
    'codex',
    'gpt-5',
  );
  assert.match(command, /unset TMUX TMUX_PANE/);
  assert.match(command, /export FARMSLOT_BACKLOG_REFINEMENT=1/);
  assert.match(command, /export FARMSLOT_RUNNER_SCOPE=backlog-refinement/);
});
