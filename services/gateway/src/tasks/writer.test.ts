import assert from 'node:assert/strict';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { farmslotRoot } from '../projects/repo-root.js';

import { assertArtifactOnlyTaskGuard } from './artifact-only-guard.js';
import { CHECKLIST_MARKER_INPUT } from './sidecars.js';
import {
  applyArtifactOnlyTaskPolicy,
  buildTaskFolderPrefix,
  buildTemplateProvenance,
  checklistMarkerHelperPath,
  COMMENT_SUMMARY_MAX_ROWS,
  type CommentRow,
  findTaskDirCollisions,
  formatPrTitleSuffix,
  isBotAuthor,
  renderCommentSummary,
  TEMPLATE_PROVENANCE_INPUT,
  writeTaskFile,
} from './writer.js';

test('buildTaskFolderPrefix keeps production collisions ticket-scoped', () => {
  assert.equal(buildTaskFolderPrefix('PROJ-1234'), 'proj-1234-');
});

test('buildTaskFolderPrefix makes comparison collisions variant-aware', () => {
  assert.equal(buildTaskFolderPrefix('PROJ-1234', 'claude'), 'proj-1234-claude-');
  assert.equal(buildTaskFolderPrefix('PROJ-1234', 'codex'), 'proj-1234-codex-');
});

test('findTaskDirCollisions allows comparison siblings with different variants', () => {
  const entries = [
    'proj-1234-claude-0415-1000',
    'proj-1234-codex-0415-1001',
    'proj-1234-0415-1002',
  ];
  assert.deepEqual(findTaskDirCollisions(entries, 'PROJ-1234', 'claude'), [
    'proj-1234-claude-0415-1000',
  ]);
  assert.deepEqual(findTaskDirCollisions(entries, 'PROJ-1234', 'codex'), [
    'proj-1234-codex-0415-1001',
  ]);
  assert.deepEqual(findTaskDirCollisions(entries, 'PROJ-1234'), entries);
});

test('buildTemplateProvenance hashes the source template content', async () => {
  const provenance = await buildTemplateProvenance({
    flowType: 'fix-bug',
    project: 'farm',
    templatePath: '/tmp/project/templates/worker/fix-bug.md',
    templateName: 'fix-bug.md',
    templateContent: '# Worker\n',
    projectRepoPath: '/tmp/not-a-git-repo',
    renderedAt: '2026-05-11T00:00:00.000Z',
  });
  assert.equal(provenance.kind, 'task-template');
  assert.equal(provenance.taskProfile, 'fix-bug');
  assert.equal(provenance.contentHash.length, 64);
  assert.equal(provenance.source, 'current-project');
});

function makeRun(ticket: string, variant: string): Run {
  return {
    id: `run-${variant}`,
    familyId: 'family-int',
    parentRunId: null,
    familyRootTicketOrPr: ticket,
    lane: 'comparison',
    variant,
    flowType: 'dev',
    mode: 'interactive',
    status: 'writing-task',
    project: 'farmslot',
    ticketOrPr: ticket,
    slotId: 'demo-ff-1',
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: 'sonnet',
      runner: 'fake',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ticketData: {
      source: 'manual',
      title: ticket,
      description: '',
      acceptanceCriteria: [],
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  };
}

function makeArtifactOnlyReplayRun(): Pick<
  Run,
  'completionPolicy' | 'flowType' | 'lane' | 'startRef' | 'engineState'
> {
  return {
    flowType: 'dev',
    lane: 'comparison',
    completionPolicy: 'artifact-only',
    startRef: {
      requestedRef: 'd093245718bfceacefaa4c7961799cc86fc9d1a8',
      source: { kind: 'manual' },
    },
    engineState: {
      evalExperiment: {
        capGroupId: undefined,
        suiteId: undefined,
        experimentId: 'experiment-test',
        experimentKey: 'experiment-key-test',
        experimentManifestPath: '/tmp/experiment.json',
        packagePath: '/tmp/candidate.result-package.json',
        candidateStrategyFingerprint: 'abc123',
        trialId: 'trial-test',
      },
    },
  };
}

function makeArtifactOnlyReplayRunWithoutStartRef(): Pick<
  Run,
  'completionPolicy' | 'flowType' | 'lane' | 'startRef' | 'engineState'
> {
  return {
    flowType: 'fix-bug',
    lane: 'comparison',
    completionPolicy: 'artifact-only',
    startRef: undefined,
    engineState: undefined,
  };
}

const PUBLISHING_DEV_TEMPLATE_SHAPE = `# Worker: Dev

## Task

\`\`\`
BRANCH: replay-branch
PR_NUMBER:
REPO: /tmp/repo
\`\`\`

- [ ] **3. Resolve branch and PR number:**
  - **If PR_NUMBER is set** — confirm you are on branch.
  - **If PR_NUMBER is empty** — create the branch and draft PR:
    \`\`\`bash
    cd /tmp/repo
    git checkout -b replay-branch
    git push -u origin replay-branch
    unset GH_TOKEN && gh pr create --draft --base main --head replay-branch --title "feat: replay" --body "WIP"
    \`\`\`
    Update \`PR_NUMBER:\` in the Task block above with the PR number from output.

- [ ] **25. HUMAN GATE — Present report, PR description, and final diff:**
  **STOP and wait for commit/push approval.**

- [ ] **26. On approval — commit, push, update PR:**
  \`\`\`bash
  git push origin replay-branch
  unset GH_TOKEN && gh pr edit <PR_NUMBER> --body-file /tmp/report.md
  \`\`\`
  Set \`STATUS: done\`.
`;

const SIMPLE_PUBLISHING_DEV_TEMPLATE_SHAPE = `# Worker: Feature — PROJ-1

## Task

\`\`\`text
BRANCH: replay-branch
TASK_DIR: /tmp/task
\`\`\`

## Checklist

- [ ] **4. Create branch** — \`git checkout -b replay-branch\`
- [ ] **11. Commit** — atomic commit following the repo protocol.
- [ ] **12. Push and create draft PR** — \`git push -u origin replay-branch\`, create PR referencing PROJ-1.
- [ ] **13. Write report and signal** — create \`/tmp/task/artifacts/report.md\`, update \`STATUS: done\`, write \`SIGNAL.json\`.
`;

const FORBIDDEN_PUBLISH_SNIPPETS = [
  /\bgh\s+pr\s+create\b/i,
  /\bgh\s+pr\s+edit\b/i,
  /\bgh\s+pr\s+comment\b/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bgit\s+push\b/i,
  /create the branch and draft PR/i,
  /commit\/push approval/i,
  /On approval — commit, push, update PR/i,
];

test('artifact-only task guard rejects push and publication variants', () => {
  assert.throws(
    () => assertArtifactOnlyTaskGuard('git push --set-upstream origin branch'),
    /forbidden git push instruction/,
  );
  assert.throws(
    () => assertArtifactOnlyTaskGuard('git push -f origin branch'),
    /forbidden git push instruction/,
  );
  assert.throws(
    () => assertArtifactOnlyTaskGuard('Commit and push after validation.'),
    /forbidden commit-and-push instruction/,
  );
  assert.throws(
    () => assertArtifactOnlyTaskGuard('Publish branch for review.'),
    /forbidden branch publication instruction/,
  );
  assert.throws(
    () => assertArtifactOnlyTaskGuard('Do not skip validation, then git push origin branch.'),
    /forbidden git push instruction/,
  );
  assert.throws(
    () => assertArtifactOnlyTaskGuard('Do not skip verification and git push origin branch.'),
    /forbidden git push instruction/,
  );
  assert.throws(
    () => assertArtifactOnlyTaskGuard('Do not forget to git push origin branch.'),
    /forbidden git push instruction/,
  );
  assert.throws(
    () => assertArtifactOnlyTaskGuard("Don't forget to open a PR when done."),
    /forbidden open-PR instruction/,
  );
  assert.throws(
    () => assertArtifactOnlyTaskGuard('Never forget to publish the branch.'),
    /forbidden branch publication instruction/,
  );
  assert.throws(
    () => assertArtifactOnlyTaskGuard('Never run gh pr create unless reviewers approve.'),
    /forbidden GitHub PR creation command/,
  );
  assert.throws(
    () => assertArtifactOnlyTaskGuard('Never run gh pr create, unless reviewers approve.'),
    /forbidden GitHub PR creation command/,
  );
  assert.throws(
    () => assertArtifactOnlyTaskGuard('Never run gh pr create: except when reviewers approve.'),
    /forbidden GitHub PR creation command/,
  );
  assert.throws(
    () => assertArtifactOnlyTaskGuard('Never run gh pr create — unless reviewers approve.'),
    /forbidden GitHub PR creation command/,
  );
  assert.doesNotThrow(() =>
    assertArtifactOnlyTaskGuard('Do not git push --set-upstream origin branch.'),
  );
  assert.doesNotThrow(() => assertArtifactOnlyTaskGuard('Never run gh pr create.'));
  assert.doesNotThrow(() =>
    assertArtifactOnlyTaskGuard('Never mark ready until the human approves.'),
  );
  assert.doesNotThrow(() => assertArtifactOnlyTaskGuard('Must not git push when asked.'));
  assert.doesNotThrow(() =>
    assertArtifactOnlyTaskGuard('You must not allow worker to mark ready.'),
  );
});

test('artifact-only task policy strips dev publishing instructions from replay tasks', () => {
  assert.throws(() => assertArtifactOnlyTaskGuard(PUBLISHING_DEV_TEMPLATE_SHAPE), /forbidden/);

  const safe = applyArtifactOnlyTaskPolicy(
    PUBLISHING_DEV_TEMPLATE_SHAPE,
    makeArtifactOnlyReplayRun(),
  );

  assert.match(safe, /Artifact-only replay guardrails/);
  assert.match(safe, /artifact-only comparison replay/);
  assert.match(safe, /Ignore injected recipe-harness overlay paths/);
  assert.match(safe, /scripts\/perps\/agentic/);
  assert.match(safe, /no remote pushes, no GitHub PR CLI mutations/);
  assert.match(safe, /Leave `PR_NUMBER:` empty/);
  for (const forbidden of FORBIDDEN_PUBLISH_SNIPPETS) {
    assert.doesNotMatch(safe, forbidden);
  }
  assert.doesNotThrow(() => assertArtifactOnlyTaskGuard(safe));
});

test('artifact-only task policy strips simple dev publishing checklist shapes', () => {
  assert.throws(
    () => assertArtifactOnlyTaskGuard(SIMPLE_PUBLISHING_DEV_TEMPLATE_SHAPE),
    /forbidden/,
  );

  const safe = applyArtifactOnlyTaskPolicy(
    SIMPLE_PUBLISHING_DEV_TEMPLATE_SHAPE,
    makeArtifactOnlyReplayRun(),
  );

  assert.match(safe, /Artifact-only replay guardrails/);
  assert.match(safe, /publication instruction removed/);
  for (const forbidden of FORBIDDEN_PUBLISH_SNIPPETS) {
    assert.doesNotMatch(safe, forbidden);
  }
  assert.doesNotThrow(() => assertArtifactOnlyTaskGuard(safe));
});

test('artifact-only task policy rewrites replay baseline guidance without changing normal dispatch', () => {
  const template = [
    '# Worker: Fix Bug',
    '',
    '## Task',
    '',
    '```text',
    'BRANCH: replay-branch',
    'REPO: /tmp/repo',
    '```',
    '',
    '- Confirm you are on branch `replay-branch` in `/tmp/repo`, or create it from `main` if needed.',
    '```bash',
    "git diff main...HEAD -- ':!*.test.ts'",
    'git log main..HEAD --oneline',
    'git log HEAD..main --oneline',
    '```',
  ].join('\n');
  const normal = applyArtifactOnlyTaskPolicy(template, {
    flowType: 'fix-bug',
    lane: 'production',
    completionPolicy: undefined,
    startRef: undefined,
    engineState: undefined,
  });
  assert.equal(normal, template);

  const safe = applyArtifactOnlyTaskPolicy(template, {
    flowType: 'fix-bug',
    lane: 'comparison',
    completionPolicy: 'artifact-only',
    startRef: { requestedRef: 'base-request', source: { kind: 'manual' }, resolvedSha: 'abc123' },
    engineState: undefined,
  });

  assert.match(safe, /do not use `main` as the comparison baseline/);
  assert.match(safe, /git diff abc123/);
  assert.match(safe, /git log abc123\.\.HEAD/);
  assert.match(safe, /git log HEAD\.\.abc123/);
  assert.doesNotMatch(safe, /git diff main\.\.\.HEAD/);
  assert.doesNotMatch(safe, /git log main\.\.HEAD/);
  assert.doesNotMatch(safe, /create it from `main` if needed/);
});

test('artifact-only task policy strips publishing instructions without startRef', () => {
  const template = [
    '# Worker: Bugfix',
    '',
    '- Resolve locally.',
    '- Do **not** run `git push`, `gh pr create`, `gh pr edit`, or `gh pr comment`.',
    '- If everything passes, create a draft PR.',
  ].join('\n');

  const safe = applyArtifactOnlyTaskPolicy(template, makeArtifactOnlyReplayRunWithoutStartRef());

  assert.match(safe, /selected reference\/base/);
  assert.doesNotMatch(safe, /Ignore injected recipe-harness overlay paths/);
  assert.doesNotMatch(safe, /gh pr create/i);
  assert.doesNotMatch(safe, /git push/i);
  assert.doesNotMatch(safe, /create a draft PR/i);
  assert.doesNotThrow(() => assertArtifactOnlyTaskGuard(safe));
});

test('writeTaskFile allows comparison siblings with different variants', async (t) => {
  const ticket = `PROJ-${Date.now()}`;
  const runA = makeRun(ticket, 'claude');
  const runB = makeRun(ticket, 'codex');

  let taskA = '';
  let taskB = '';
  t.after(async () => {
    const dirs = [taskA, taskB].filter(Boolean).map((p) => path.dirname(p));
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  taskA = await writeTaskFile(runA);
  taskB = await writeTaskFile(runB);

  assert.notEqual(taskA, taskB);
  assert.match(taskA, /claude-/);
  assert.match(taskB, /codex-/);
  const provenance = JSON.parse(
    await readFile(path.join(path.dirname(taskA), TEMPLATE_PROVENANCE_INPUT), 'utf-8'),
  ) as { contentHash?: string; templateName?: string };
  assert.equal(provenance.templateName, 'dev-interactive.md');
  assert.equal(typeof provenance.contentHash, 'string');
  await access(path.join(path.dirname(taskA), CHECKLIST_MARKER_INPUT));
});


test('checklistMarkerHelperPath keeps remote helper shell-expandable', () => {
  assert.equal(
    checklistMarkerHelperPath('~/farmslot-node'),
    '$HOME/farmslot-node/packages/skills/scripts/mark-checklist-step.cjs',
  );
});

test('renderCommentSummary returns placeholder when no rows — worker still re-fetches', () => {
  const out = renderCommentSummary([]);
  assert.match(out, /No human or unresolved bot comments/);
  assert.match(out, /step 4/);
});

test('renderCommentSummary tables issue + review rows with file:line for review entries', () => {
  const rows: CommentRow[] = [
    {
      source: 'issue',
      author: 'geositta',
      body: 'Testing this branch and main and have an issue with back button',
      createdAt: '2026-04-28T00:22:43Z',
    },
    {
      source: 'review',
      id: 9,
      author: 'cursor[bot]',
      body: 'Placeholder min $10 shown misleadingly',
      path: 'ui/components/foo.tsx',
      line: 352,
      createdAt: '2026-04-22T10:35:01Z',
    },
  ];
  const out = renderCommentSummary(rows);
  assert.match(out, /\| issue \| geositta \| conversation \| Testing this branch/);
  assert.match(
    out,
    /\| review \| cursor\[bot\] \| ui\/components\/foo\.tsx:352 \| Placeholder min \$10/,
  );
});

test('renderCommentSummary collapses whitespace so multi-line bodies stay one row', () => {
  const rows: CommentRow[] = [
    { source: 'issue', author: 'a', body: 'line one\nline two\n\nline three' },
  ];
  const out = renderCommentSummary(rows);
  assert.match(out, /\| line one line two line three \|/);
});

test('renderCommentSummary truncates beyond COMMENT_SUMMARY_MAX_ROWS and notes the omission', () => {
  const rows: CommentRow[] = Array.from({ length: COMMENT_SUMMARY_MAX_ROWS + 5 }, (_, i) => ({
    source: 'issue' as const,
    author: `u${i}`,
    body: `body${i}`,
  }));
  const out = renderCommentSummary(rows);
  assert.match(out, /5 more comment\(s\) omitted/);
  assert.match(out, /\| u0 \|/);
  assert.equal(out.includes('| u' + (COMMENT_SUMMARY_MAX_ROWS + 4) + ' |'), false);
});

test('isBotAuthor flags [bot] suffix and Bot user type', () => {
  assert.equal(isBotAuthor({ author: 'cursor[bot]' }), true);
  assert.equal(isBotAuthor({ author: 'examplebotv2[bot]' }), true);
  assert.equal(isBotAuthor({ author: 'github-actions[bot]' }), true);
  assert.equal(isBotAuthor({ author: 'someuser', userType: 'Bot' }), true);
  assert.equal(isBotAuthor({ author: 'geositta' }), false);
  assert.equal(isBotAuthor({ author: 'deeeed', userType: 'User' }), false);
});

test('renderCommentSummary drops bot issue rows but keeps bot review rows (cursor[bot] flags real findings)', () => {
  const rows: CommentRow[] = [
    { source: 'issue', author: 'examplebotv2[bot]', body: 'Builds ready [abc123]' },
    {
      source: 'issue',
      author: 'github-actions[bot]',
      body: 'CLA Signature Action: All authors signed',
    },
    { source: 'issue', author: 'geositta', body: 'Back button broken on this branch' },
    {
      source: 'review',
      author: 'cursor[bot]',
      body: 'Placeholder min $10 misleadingly shown',
      path: 'ui/foo.tsx',
      line: 42,
    },
    {
      source: 'review',
      author: 'deeeed',
      body: 'Fixed in commit X',
      path: 'ui/foo.tsx',
      line: 42,
    },
  ];
  const out = renderCommentSummary(rows);
  assert.equal(out.includes('examplebotv2[bot]'), false);
  assert.equal(out.includes('github-actions[bot]'), false);
  assert.match(out, /\| issue \| geositta \| conversation \| Back button broken/);
  assert.match(out, /\| review \| cursor\[bot\] \| ui\/foo\.tsx:42 \| Placeholder/);
  assert.match(out, /\| review \| deeeed \| ui\/foo\.tsx:42 \| Fixed/);
  assert.match(out, /2 bot-issue comment\(s\) hidden from preview/);
});

test('renderCommentSummary all-bot-issues edge case prompts worker to consult pr-comments.json', () => {
  const rows: CommentRow[] = [
    { source: 'issue', author: 'examplebotv2[bot]', body: 'Builds ready' },
    { source: 'issue', author: 'sonarqubecloud[bot]', body: 'Quality Gate passed' },
  ];
  const out = renderCommentSummary(rows);
  assert.match(out, /All 2 fetched comment\(s\) were bot-issue noise/);
  assert.match(out, /pr-comments\.json/);
});

test('formatPrTitleSuffix normalizes the configured human gate suffix', () => {
  assert.equal(formatPrTitleSuffix('[NOT-READY]'), ' [NOT-READY]');
  assert.equal(formatPrTitleSuffix(' [NOT-READY]  '), ' [NOT-READY]');
  assert.equal(formatPrTitleSuffix(''), '');
  assert.equal(formatPrTitleSuffix(undefined), '');
});

test('writeTaskFile renders selected template variant and leaves source template unchanged', async (t) => {
  const workerDir = path.join(farmslotRoot, 'projects', 'farmslot', 'templates', 'worker');
  const sourcePath = path.join(workerDir, 'dev.md');
  const variantPath = path.join(workerDir, 'dev-template-test.md');
  const source = await readFile(sourcePath, 'utf-8');
  const variantSource = `${source}\n\nTemplate version marker: {{TICKET}}\n`;
  await writeFile(variantPath, variantSource, 'utf-8');
  let taskPath = '';
  t.after(async () => {
    if (taskPath) await rm(path.dirname(taskPath), { recursive: true, force: true });
    await rm(variantPath, { force: true });
  });

  const run = makeRun(`PROJ-${Date.now()}`, 'variant');
  run.taskTemplate = { fileName: 'dev-template-test.md', variant: 'template-test' };
  taskPath = await writeTaskFile(run, { skipCollisionCheck: true });

  const rendered = await readFile(taskPath, 'utf-8');
  const provenance = JSON.parse(
    await readFile(path.join(path.dirname(taskPath), TEMPLATE_PROVENANCE_INPUT), 'utf-8'),
  ) as { templateName?: string; templateVariant?: string | null; templateIsDefault?: boolean };
  assert.match(rendered, /Template version marker: PROJ-/);
  assert.equal(await readFile(variantPath, 'utf-8'), variantSource);
  assert.equal(provenance.templateName, 'dev-template-test.md');
  assert.equal(provenance.templateVariant, 'template-test');
  assert.equal(provenance.templateIsDefault, false);
});

test('writeTaskFile implicitly renders dev-interactive template for interactive dev', async (t) => {
  const run = makeRun(`PROJ-${Date.now()}`, 'interactive-template');
  let taskPath = '';
  t.after(async () => {
    if (taskPath) await rm(path.dirname(taskPath), { recursive: true, force: true });
  });

  taskPath = await writeTaskFile(run, { skipCollisionCheck: true });

  const rendered = await readFile(taskPath, 'utf-8');
  const provenance = JSON.parse(
    await readFile(path.join(path.dirname(taskPath), TEMPLATE_PROVENANCE_INPUT), 'utf-8'),
  ) as {
    templateName?: string;
    templateSelectionSource?: string;
    templateSelectionReason?: string;
  };
  assert.match(rendered, /Worker: Interactive Dev/);
  assert.equal(provenance.templateName, 'dev-interactive.md');
  assert.equal(provenance.templateSelectionSource, 'implicit-interactive-dev');
  assert.match(provenance.templateSelectionReason ?? '', /interactive mode/);
  for (const forbidden of FORBIDDEN_PUBLISH_SNIPPETS) {
    assert.doesNotMatch(rendered, forbidden);
  }
});

test('writeTaskFile implicitly renders pr-complete-interactive template for interactive pr-complete', async (t) => {
  const workerDir = path.join(farmslotRoot, 'projects', 'farmslot', 'templates', 'worker');
  const variantPath = path.join(workerDir, 'pr-complete-interactive.md');
  await writeFile(
    variantPath,
    [
      '# Worker: Interactive PR-Complete',
      '',
      'PR: {{PR_NUMBER}}',
      'BRANCH: {{PR_BRANCH}}',
      'TASK_DIR: {{TASK_DIR}}',
      'STATUS: pending',
      '',
      'Do not write terminal `SIGNAL.json`.',
      '',
    ].join('\n'),
    'utf-8',
  );
  const run = makeRun('123', 'interactive-pr-complete');
  run.flowType = 'pr-complete';
  run.familyRootTicketOrPr = '123';
  run.branch = 'feature/pr-123';
  let taskPath = '';
  t.after(async () => {
    if (taskPath) await rm(path.dirname(taskPath), { recursive: true, force: true });
    await rm(variantPath, { force: true });
  });

  taskPath = await writeTaskFile(run, { skipCollisionCheck: true });

  const rendered = await readFile(taskPath, 'utf-8');
  const provenance = JSON.parse(
    await readFile(path.join(path.dirname(taskPath), TEMPLATE_PROVENANCE_INPUT), 'utf-8'),
  ) as {
    templateName?: string;
    templateSelectionSource?: string;
    templateSelectionReason?: string;
  };
  assert.match(rendered, /Worker: Interactive PR-Complete/);
  assert.match(rendered, /Interactive PR-complete handoff/);
  assert.match(rendered, /STATUS: waiting-human/);
  assert.match(rendered, /Do \*\*not\*\* write a terminal `SIGNAL\.json`/);
  assert.equal(provenance.templateName, 'pr-complete-interactive.md');
  assert.equal(provenance.templateSelectionSource, 'implicit-interactive-pr-complete');
  assert.match(provenance.templateSelectionReason ?? '', /interactive mode/);
});

test('writeTaskFile appends interactive PR-complete handoff to default template when variant is absent', async (t) => {
  const workerDir = path.join(farmslotRoot, 'projects', 'farmslot', 'templates', 'worker');
  const variantPath = path.join(workerDir, 'pr-complete-interactive.md');
  const previousVariant = await readFile(variantPath, 'utf-8').catch(() => null);
  await rm(variantPath, { force: true });
  const run = makeRun('456', 'interactive-pr-complete-default');
  run.flowType = 'pr-complete';
  run.mode = 'interactive';
  run.familyRootTicketOrPr = '456';
  run.branch = 'feature/pr-456';
  let taskPath = '';
  t.after(async () => {
    if (taskPath) await rm(path.dirname(taskPath), { recursive: true, force: true });
    if (previousVariant != null) await writeFile(variantPath, previousVariant, 'utf-8');
  });

  taskPath = await writeTaskFile(run, { skipCollisionCheck: true });

  const rendered = await readFile(taskPath, 'utf-8');
  const provenance = JSON.parse(
    await readFile(path.join(path.dirname(taskPath), TEMPLATE_PROVENANCE_INPUT), 'utf-8'),
  ) as {
    templateName?: string;
    templateSelectionSource?: string;
    templateSelectionReason?: string;
  };
  assert.match(rendered, /Interactive PR-complete handoff/);
  assert.match(rendered, /STATUS: waiting-human/);
  assert.match(rendered, /Do \*\*not\*\* write a terminal `SIGNAL\.json`/);
  assert.equal(provenance.templateName, 'pr-complete.md');
  assert.equal(provenance.templateSelectionSource, 'default');
  assert.match(provenance.templateSelectionReason ?? '', /absent, using default/);
});

test('writeTaskFile fails loudly when explicit selected template disappears', async () => {
  const run = makeRun(`PROJ-${Date.now()}`, 'missing-template');
  run.taskTemplate = { fileName: 'dev-definitely-missing.md', variant: 'definitely-missing' };
  await assert.rejects(
    () => writeTaskFile(run, { skipCollisionCheck: true }),
    /selected Worker template not found:/,
  );
});
