// @farmslot:serial — writes fixed-name template variants into the shared repo
// `projects/<project>/templates/worker/` directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PLANNING_CONTEXT_MAX_RELATIONS,
  type PlanningContextProjection,
  type Run,
} from '@farmslot/protocol';
import { normalizeRawRuntimeCapabilities } from '@farmslot/slot-config';

import { farmslotRoot } from '../projects/repo-root.js';

// These tests exercise runs on the committed demo pool's slots (demo-ff-1),
// which the loaders hide unless explicitly opted in.
process.env.FARMSLOT_DEMO_POOL = '1';

import { assertArtifactOnlyTaskGuard } from './artifact-only-guard.js';
import { buildPlanningContextSection } from './planning-context.js';
import { CHECKLIST_MARKER_INPUT } from './sidecars.js';
import {
  appendRuntimeCapabilityAndPlanningContext,
  applyArtifactOnlyTaskPolicy,
  buildChecklistMarkerScript,
  buildTaskFolderPrefix,
  buildTemplateProvenance,
  checklistForInteractiveDev,
  checklistMarkerHelperPath,
  checklistNumberingMismatches,
  COMMENT_SUMMARY_MAX_ROWS,
  type CommentRow,
  findTaskDirCollisions,
  formatPrTitleSuffix,
  generateTaskSchema,
  isBotAuthor,
  PREVIOUS_REVIEW_JSON_INPUT,
  PREVIOUS_REVIEW_MD_INPUT,
  renderCommentSummary,
  STATIC_REVIEW_INSTRUCTIONS_DIR,
  TEMPLATE_PROVENANCE_INPUT,
  writePreviousReviewInputs,
  writeStaticReviewInstructionInputs,
  writeTaskFile,
} from './writer.js';

test('runtime proof planning precedes acquisition guidance and retains related planning context', () => {
  const providers = normalizeRawRuntimeCapabilities({
    providers: {
      'browser-cdp': {
        label: 'Browser / CDP',
        version: '1',
        share_policy: 'exclusive',
        cost: {
          class: 'high',
          resources: [{ id: 'cdp-port', access: 'exclusive', kind: 'port' }],
        },
        actions: {
          acquire: { kind: 'slot-action', action_id: 'browser-start' },
          health: { kind: 'slot-action', action_id: 'browser-health' },
          release: { kind: 'slot-action', action_id: 'browser-stop' },
        },
        release_effects: ['Stop the browser'],
      },
    },
  })!.providers;
  const task = appendRuntimeCapabilityAndPlanningContext(
    '# Worker task\n',
    '.task/run-a',
    providers,
    {
      backlogItemId: 'MANUAL-000073',
      relations: [
        {
          label: 'depends-on',
          direction: 'upstream',
          targetKind: 'backlog',
          targetId: 'MANUAL-000072',
          targetRef: 'MANUAL-000072',
          targetTitle: 'Roadmap delivery/planning lineage',
          source: 'work-graph-reference',
          schedulerAuthority: false,
          reason: 'related planning context',
        },
      ],
      generatedAt: '2026-08-11T00:00:00.000Z',
      snapshotHash: 'snapshot-1',
    },
  );

  assert(task.indexOf('Runtime capability proof plan') < task.indexOf('Related planning context'));
  assert.match(task, /Before the first\s+`runtime\.capability\.acquire` call/);
  assert.match(task, /`browser-cdp` — Browser \/ CDP; high cost; exclusive/);
  assert.match(task, /MANUAL-000072.*Roadmap delivery\/planning lineage/);
  assert.match(task, /inputs\/runtime-capability-catalog\.json/);
});

test('writePreviousReviewInputs freezes reusable review context as JSON and a concise brief', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'previous-review-inputs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'inputs'), { recursive: true });

  const written = await writePreviousReviewInputs(dir, {
    version: 1,
    chainId: 'chain-1',
    generation: 2,
    contextMode: 'reuse',
    priorRunId: 'prior-run',
    priorFamilyId: 'family-1',
    repository: 'owner/repo',
    prNumber: 42,
    priorReviewedHeadSha: 'prior-head',
    currentHeadSha: 'current-head',
    verdict: 'request changes',
    unresolvedFindings: [{ file: 'src/a.ts', line: 7, description: 'Fix this.' }],
    artifactRefs: [{ path: 'artifacts/review.md', purpose: 'review' }],
    farmslotEvidenceRefs: [{ path: 'artifacts/recipe.json', purpose: 'recipe proof' }],
    reviewScope: 'incremental',
    validationDepth: 'static-code',
    sessionIntent: 'resume',
    priorGenerations: [],
  });

  assert.deepEqual(written, [PREVIOUS_REVIEW_JSON_INPUT, PREVIOUS_REVIEW_MD_INPUT]);
  const json = JSON.parse(await readFile(path.join(dir, PREVIOUS_REVIEW_JSON_INPUT), 'utf-8'));
  assert.equal(json.currentHeadSha, 'current-head');
  const markdown = await readFile(path.join(dir, PREVIOUS_REVIEW_MD_INPUT), 'utf-8');
  assert.match(markdown, /Scope: incremental/);
  assert.match(markdown, /src\/a\.ts:7 — Fix this\./);
  assert.match(markdown, /artifacts\/recipe\.json/);
});

test('writeStaticReviewInstructionInputs freezes configured project guidance without prepare', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-review-instructions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixtures = path.join(dir, 'fixtures');
  await mkdir(path.join(fixtures, 'runtime'), { recursive: true });
  await writeFile(path.join(fixtures, 'runtime/domain-rules.md'), '# Domain rules\n', 'utf-8');

  const written = await writeStaticReviewInstructionInputs(
    dir,
    {
      projectName: 'farm-a',
      projectConfig: path.join(dir, 'project.json'),
      projectFixturesDir: fixtures,
      projectTemplatesDir: path.join(dir, 'templates'),
      projectJson: { static_review: { instruction_files: ['runtime/domain-rules.md'] } },
      runtimeDir: '.agent',
      artifactDir: '.task',
      recipeDir: '.agent/recipes',
    },
    { flowType: 'review-pr', reviewValidationDepth: 'static-code' },
  );

  assert.deepEqual(written, [`${STATIC_REVIEW_INSTRUCTIONS_DIR}/runtime/domain-rules.md`]);
  assert.equal(await readFile(path.join(dir, written[0]!), 'utf-8'), '# Domain rules\n');
});

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
    project: 'farmslot-farm',
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
  const manifest = JSON.parse(
    await readFile(path.join(path.dirname(taskA), 'checklist-target.json'), 'utf-8'),
  );
  assert.deepEqual(manifest, { checklist: 'TASK.md' });
});

test('checklistMarkerHelperPath keeps remote helper shell-expandable', () => {
  assert.equal(
    checklistMarkerHelperPath('~/farmslot-node'),
    '$HOME/farmslot-node/packages/agent-runtime/scripts/mark-checklist-step.cjs',
  );
});

test('mark wrapper resolves the published bin with a recorded-path fallback', async (t) => {
  let taskFile = '';
  t.after(async () => {
    if (taskFile) await rm(path.dirname(taskFile), { recursive: true, force: true });
  });
  taskFile = await writeTaskFile(makeRun('MARK-1234', 'claude'));
  const marker = await readFile(path.join(path.dirname(taskFile), CHECKLIST_MARKER_INPUT), 'utf-8');
  // Ladder: env override → recorded slot-synced path → PATH → teach.
  assert.match(marker, /FARMSLOT_AGENT_BIN/);
  // The env rung requires the override to be executable so a bad value falls
  // through the ladder instead of hard-dying under `set -euo pipefail`.
  assert.match(
    marker,
    /\[ -n "\$\{FARMSLOT_AGENT_BIN:-\}" \] && \[ -x "\$\{FARMSLOT_AGENT_BIN\}" \]/,
  );
  assert.match(marker, /exec "\$FARMSLOT_AGENT_BIN" mark "\$DIR"/);
  assert.match(marker, /command -v farmslot-agent/);
  assert.match(marker, /exec farmslot-agent mark "\$DIR"/);
  // Recorded dev/checkout fallback keeps the pre-publish behaviour identical.
  assert.match(marker, /exec node "\$RECORDED" "\$DIR"/);
  assert.match(marker, /packages\/agent-runtime\/scripts\/mark-checklist-step\.cjs/);
  // Unresolved bin teaches the escape and exits non-zero.
  assert.match(marker, /Next: install it .*farmslot-agent.* on PATH.*FARMSLOT_AGENT_BIN/s);
  assert.match(marker, /exit 127/);
});

test('generated mark wrapper executes the right ladder rung', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'markwrap-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const recordFile = path.join(dir, 'record.txt');
  const readRecord = async () => {
    try {
      return await readFile(recordFile, 'utf-8');
    } catch {
      return '';
    }
  };
  const writeStubBin = async (file: string, tag: string) => {
    await writeFile(
      file,
      `#!/usr/bin/env bash\nprintf '${tag} %s\\n' "$*" >> ${JSON.stringify(recordFile)}\n`,
      'utf-8',
    );
    await chmod(file, 0o755);
  };

  // env rung stub, and a PATH-only stub named `farmslot-agent` in its own dir so
  // it is reachable only when that dir is on PATH.
  const envStub = path.join(dir, 'env-agent');
  await writeStubBin(envStub, 'ENV');
  const pathbin = path.join(dir, 'bin');
  await mkdir(pathbin, { recursive: true });
  await writeStubBin(path.join(pathbin, 'farmslot-agent'), 'PATH');
  // recorded-rung stub: a .cjs the wrapper runs via `node`.
  const recordedCjs = path.join(dir, 'recorded.cjs');
  await writeFile(
    recordedCjs,
    `require('node:fs').appendFileSync(${JSON.stringify(recordFile)}, 'CJS ' + process.argv.slice(2).join(' ') + '\\n');\n`,
    'utf-8',
  );

  const markPath = path.join(dir, 'mark');
  await writeFile(markPath, buildChecklistMarkerScript(recordedCjs), 'utf-8');
  await chmod(markPath, 0o755);
  await writeFile(path.join(dir, 'TASK.md'), '- [ ] step\n', 'utf-8');

  const nodeDir = path.dirname(process.execPath);
  const cleanPath = `${nodeDir}:/usr/bin:/bin`; // node available, no farmslot-agent
  const withPathBin = `${pathbin}:${cleanPath}`; // farmslot-agent resolvable via PATH
  const run = (env: Record<string, string>) =>
    spawnSync('bash', [markPath, 'N'], {
      cwd: dir,
      encoding: 'utf-8',
      env: { HOME: process.env.HOME ?? '', ...env },
    });

  // 1. env rung wins even when the PATH bin is present.
  let r = run({ PATH: withPathBin, FARMSLOT_AGENT_BIN: envStub });
  assert.equal(r.status, 0);
  assert.match(await readRecord(), /^ENV mark .* N$/m);
  await rm(recordFile, { force: true });

  // 2. a non-executable override falls through to the recorded rung.
  const badBin = path.join(dir, 'not-exec');
  await writeFile(badBin, 'nope', 'utf-8'); // deliberately not chmod +x
  r = run({ PATH: withPathBin, FARMSLOT_AGENT_BIN: badBin });
  assert.equal(r.status, 0);
  assert.match(await readRecord(), /^CJS .* N$/m);
  await rm(recordFile, { force: true });

  // 3. The recorded slot-synced helper wins over a possibly stale PATH bin.
  r = run({ PATH: withPathBin });
  assert.equal(r.status, 0);
  assert.match(await readRecord(), /^CJS .* N$/m);
  await rm(recordFile, { force: true });

  // 4. PATH is the fallback when the recorded helper is unavailable.
  await rm(recordedCjs, { force: true });
  r = run({ PATH: withPathBin });
  assert.equal(r.status, 0);
  assert.match(await readRecord(), /^PATH mark /m);
  await rm(recordFile, { force: true });

  // 5. nothing resolves → teach + exit 127.
  r = run({ PATH: cleanPath });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /Next: install it/);
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
  const workerDir = path.join(farmslotRoot, 'projects', 'farmslot-farm', 'templates', 'worker');
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
  assert.match(rendered, new RegExp(`FAMILY_ID: ${run.familyId}`));
  assert.match(rendered, new RegExp(`"ownerFamilyId":"${run.familyId}"`));
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
  const workerDir = path.join(farmslotRoot, 'projects', 'farmslot-farm', 'templates', 'worker');
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
  const workerDir = path.join(farmslotRoot, 'projects', 'farmslot-farm', 'templates', 'worker');
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

test('interactive checklist is an execution plan, never the acceptance criteria', () => {
  const run = makeRun(`PROJ-${Date.now()}`, 'interactive-checklist');
  run.ticketData = {
    title: 'Argv transport',
    description: 'desc',
    acceptanceCriteria: [
      'A caller-derived value reaches the executed program as one literal argument',
      'No caller-derived value is interpolated into shell text at any inventoried site',
    ],
  } as Run['ticketData'];

  const checklist = checklistForInteractiveDev(run);

  // The regression: acceptance criteria are end-state assertions, not steps. Using
  // them left the worker with nothing markable and the operator unable to follow
  // progress — run 32909fa2 marked 0 of 11.
  for (const ac of run.ticketData?.acceptanceCriteria ?? []) {
    assert.ok(
      !checklist.includes(ac),
      `checklist must not contain acceptance criterion: ${ac.slice(0, 40)}`,
    );
  }
  assert.ok(checklist.length > 0);
  assert.match(checklist.join('\n'), /approach\.md/);
  assert.match(checklist.join('\n'), /HUMAN GATE/);
});

test('an explicitly configured interactive checklist still wins', () => {
  const run = makeRun(`PROJ-${Date.now()}`, 'interactive-checklist-override');
  run.ticketData = {
    title: 'x',
    description: 'y',
    acceptanceCriteria: ['some criterion'],
  } as Run['ticketData'];
  run.engineState = {
    ...(run.engineState ?? {}),
    interactiveDev: { checklist: ['Do the one thing', 'Then stop'] },
  } as Run['engineState'];

  assert.deepEqual(checklistForInteractiveDev(run), ['Do the one thing', 'Then stop']);
});

test('the interactive checklist renders in the shape the schema parser reads', () => {
  // generateTaskSchema strips the FIRST bold group and discards the rest of the
  // line, so `**1.** Text` parses to a step named "1." with no label — which is
  // what Command Center rendered: eight numbers and no titles.
  const run = makeRun(`PROJ-${Date.now()}`, 'interactive-checklist-shape');
  const rendered = checklistForInteractiveDev(run)
    .map((item, index) => `- [ ] **${index + 1}. ${item}**`)
    .join('\n');
  const markdown = ['# Worker: Interactive Dev', '', '## Checklist', '', rendered, ''].join('\n');

  const schema = generateTaskSchema(markdown, 'dev');
  assert.equal(schema.totalSteps, checklistForInteractiveDev(run).length);
  const steps = schema.phases.flatMap((phase) => phase.steps);
  for (const step of steps) {
    assert.notEqual(step.name.trim(), `${step.index}.`, 'step lost its label');
    assert.ok(step.name.length > 4, `step ${step.index} has no meaningful name: ${step.name}`);
  }
  assert.match(steps[0].name, /Read the task/);
});

test('checklistNumberingMismatches flags labels that diverge from step positions', () => {
  const skewed = [
    '# Worker: Fix',
    '',
    '## Checklist',
    '',
    '- [ ] **1. First**',
    '- [ ] **1a. Sub-step without its own number**',
    '- [ ] **2. Now sits at position 3**',
  ].join('\n');
  // The suffixed label is itself reported, not just the drift it causes one row later.
  // `mark N` targets positions, so `1a` at position 2 is already the divergence; leaving
  // it unflagged is how an inserted step silently desynchronises a whole checklist.
  assert.deepEqual(checklistNumberingMismatches(skewed), [
    'position 2 is labeled "1a"',
    'position 3 is labeled "2"',
  ]);

  const aligned = [
    '## Checklist',
    '',
    '- [ ] **1. First**',
    '- [ ] Unnumbered box is fine',
    '- [ ] **3. Matches its position**',
  ].join('\n');
  assert.deepEqual(checklistNumberingMismatches(aligned), []);
});

test('graph-linked backlog run renders a bounded Related planning context section', () => {
  const projection: PlanningContextProjection = {
    backlogItemId: 'bk_target',
    roadmapItemId: 'ri_ctx',
    roadmapTitle: 'Roadmap delivery lineage',
    roadmapSpecPath: '.roadmap/inbox/items/delivery-lineage.md',
    roadmapStage: 'promoted',
    workGraphId: 'wg_delivery',
    workNodeId: 'node_target',
    delivery: {
      roadmapItemId: 'ri_ctx',
      status: 'partial',
      backlogItemCount: 2,
      deliveredBacklogItemCount: 1,
      runFamilyCount: 1,
      prCount: 1,
      findingCount: 0,
    },
    relations: [
      {
        label: 'depends-on',
        direction: 'upstream',
        targetKind: 'backlog',
        targetId: 'bk_upstream',
        targetRef: 'MANUAL-000010',
        targetTitle: 'Protocol contract',
        targetStatus: 'done',
        specPath: '.backlog/specs/manual-000010.md',
        source: 'work-graph-edge',
        schedulerAuthority: true,
        reason: 'WorkGraph edge edge_dep (merged, blocks start, status satisfied).',
      },
      {
        label: 'blocks',
        direction: 'downstream',
        targetKind: 'backlog',
        targetId: 'bk_downstream',
        targetRef: 'MANUAL-000013',
        targetStatus: 'ready',
        specPath: '.backlog/specs/manual-000013.md',
        source: 'work-graph-edge',
        schedulerAuthority: true,
        reason: 'WorkGraph edge edge_next (family-done, blocks start, status pending).',
      },
      {
        label: 'promoted-sibling',
        direction: 'sibling',
        targetKind: 'backlog',
        targetId: 'bk_sibling',
        targetRef: 'MANUAL-000012',
        targetStatus: 'running',
        specPath: '.backlog/specs/manual-000012.md',
        source: 'roadmap-promotion',
        schedulerAuthority: false,
        reason: 'Shares roadmap parent ri_ctx.',
      },
    ],
    generatedAt: '2026-08-02T10:00:00.000Z',
    snapshotHash: 'abc123def4567890',
  };

  const section = buildPlanningContextSection('tasks/dev/manual-000072', projection);

  assert.match(section, /^## Related planning context$/m);
  assert.match(section, /Snapshot hash: abc123def4567890/);
  assert.match(section, /tasks\/dev\/manual-000072\/inputs\/planning-context\.json/);
  assert.match(section, /Roadmap parent: ri_ctx — Roadmap delivery lineage \(stage promoted/);
  assert.match(section, /WorkGraph: wg_delivery node node_target/);
  assert.match(section, /Roadmap delivery: partial \(1\/2 backlog items delivered/);

  const upstream = section.split('### Upstream')[1].split('###')[0];
  assert.match(upstream, /`depends-on` MANUAL-000010/);
  assert.match(upstream, /spec \.backlog\/specs\/manual-000010\.md/);
  assert.match(upstream, /· scheduler authority ·/);

  const downstream = section.split('### Downstream')[1].split('###')[0];
  assert.match(downstream, /`blocks` MANUAL-000013/);

  const siblings = section.split('### Siblings')[1];
  assert.match(siblings, /`promoted-sibling` MANUAL-000012/);
  assert.match(siblings, /context only \(no scheduler authority\)/);

  // Bounded: refs and spec paths only, never the related spec bodies.
  assert.equal(section.includes('## Acceptance Criteria'), false);
  assert.ok(section.length < 4000, 'related context must stay a bounded summary');
});

test('standalone backlog run renders an explicit empty planning-context state', () => {
  const projection: PlanningContextProjection = {
    backlogItemId: 'bk_standalone',
    relations: [],
    generatedAt: '2026-08-02T10:00:00.000Z',
    snapshotHash: 'deadbeefdeadbeef',
  };

  const section = buildPlanningContextSection('tasks/dev/manual-000073', projection);

  assert.match(section, /^## Related planning context$/m);
  assert.match(section, /Roadmap parent: none/);
  assert.match(section, /WorkGraph: not graph-linked/);
  assert.match(section, /None: this backlog item has no roadmap or WorkGraph relations\./);
  assert.equal(section.includes('### Upstream'), false);
});

test('run without a backlog item states why planning context is empty', () => {
  const section = buildPlanningContextSection('tasks/dev/manual-000074', null);
  assert.match(section, /No related planning context: this run is not linked to a backlog item\./);
});

test('the rendered brief is capped while the snapshot keeps everything', () => {
  const relations = Array.from({ length: 40 }, (_, index) => ({
    label: 'promoted-sibling' as const,
    direction: 'sibling' as const,
    targetKind: 'backlog' as const,
    targetId: `bk_${index}`,
    targetRef: `MANUAL-${String(index).padStart(6, '0')}`,
    source: 'roadmap-promotion' as const,
    schedulerAuthority: false,
    reason: 'Shares roadmap parent ri_x.',
  }));
  const projection: PlanningContextProjection = {
    backlogItemId: 'bk_target',
    relations,
    generatedAt: '2026-08-02T10:00:00.000Z',
    snapshotHash: 'cafebabecafebabe',
  };

  const section = buildPlanningContextSection('tasks/dev/x', projection);
  const rendered = section.match(/`promoted-sibling`/g) ?? [];
  assert.equal(rendered.length, PLANNING_CONTEXT_MAX_RELATIONS, 'brief stays bounded');
  assert.match(section, /16 of 40 relations omitted here/);
  assert.match(section, /snapshot artifact above holds all 40/);
});
