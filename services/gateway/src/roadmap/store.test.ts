import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { farmslotRoot } from '../projects/repo-root.js';

const roadmapRoot = path.join(farmslotRoot, '.sandbox', `roadmap-store-test-${process.pid}`);
const backlogFile = path.join(farmslotRoot, '.sandbox', `roadmap-backlog-test-${process.pid}.json`);
const backlogSpecRoot = path.join(farmslotRoot, '.sandbox', `roadmap-backlog-specs-${process.pid}`);
const promptRoot = path.join(roadmapRoot, 'refinement-prompts');
process.env.FARMSLOT_ROADMAP_DIR = roadmapRoot;
process.env.FARMSLOT_BACKLOG_FILE = backlogFile;
process.env.FARMSLOT_BACKLOG_SPEC_DIR = backlogSpecRoot;
process.env.FARMSLOT_ROADMAP_REFINEMENT_PROMPT_DIR = promptRoot;

const storePromise = import('./store.js');

test.beforeEach(async () => {
  const backlog = await import('../backlog/store.js');
  await backlog.flushBacklogForTests();
  await Promise.all([
    rm(roadmapRoot, { recursive: true, force: true }),
    rm(backlogFile, { force: true }),
    rm(backlogSpecRoot, { recursive: true, force: true }),
    rm(promptRoot, { recursive: true, force: true }),
  ]);
  backlog.initBacklogStore(() => {});
  await backlog.loadBacklog();
});
test.after(() =>
  Promise.all([
    rm(roadmapRoot, { recursive: true, force: true }),
    rm(backlogFile, { force: true }),
    rm(backlogSpecRoot, { recursive: true, force: true }),
    rm(promptRoot, { recursive: true, force: true }),
  ]),
);

async function store() {
  return storePromise;
}

async function createProjectFixture(t: TestContext, project: string): Promise<void> {
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      repo_url: `git@example.com:${project}.git`,
      default_branch: 'main',
    }),
  );
}

function refinedBody(extra = 'Updated body.'): string {
  return [
    '## Problem',
    '',
    extra,
    '',
    '## Proposed Solution',
    '',
    'Use the roadmap refinement flow.',
    '',
    '## Non-goals',
    '',
    '- Do not generate ADRs automatically.',
    '',
    '## Risks',
    '',
    '- Scope may still be too large.',
    '',
    '## Dispatch Notes',
    '',
    'Promote into small backlog specs.',
    '',
    '## Acceptance Criteria',
    '',
    '- Refined item has a dispatchable acceptance criterion.',
  ].join('\n');
}

test('roadmap store saves rough inbox markdown and supports get/list filters', async () => {
  const { getRoadmapItem, listRoadmapItems, saveRoadmapItem } = await store();

  const created = await saveRoadmapItem({
    item: {
      title: 'Brainstorm Raw Idea',
      targetProjects: ['metamask-mobile-farm', 'metamask-extension-farm'],
      tags: [' Roadmap ', '#Command Center', 'roadmap'],
      body: 'Raw note from the operator.',
    },
  });

  assert.equal(created.item.stage, 'rough');
  assert.equal(created.item.project, 'unassigned');
  assert.deepEqual(created.item.targetProjects, [
    'metamask-extension-farm',
    'metamask-mobile-farm',
  ]);
  assert.deepEqual(created.item.tags, ['command-center', 'roadmap']);
  assert.match(
    created.item.filePath,
    /\.sandbox\/roadmap-store-test-\d+\/inbox\/items\/\d{4}-\d{2}-\d{2}-unassigned-brainstorm-raw-idea\.md$/,
  );
  assert.equal(existsSync(path.join(farmslotRoot, created.item.filePath)), true);

  const markdown = await readFile(path.join(farmslotRoot, created.item.filePath), 'utf-8');
  assert.match(markdown, /^---\nid: /);
  assert.match(markdown, /kind: "roadmap-item"/);
  assert.match(markdown, /Raw note from the operator\./);

  const byId = await getRoadmapItem({ itemId: created.item.id });
  assert.equal(byId.item.title, 'Brainstorm Raw Idea');
  assert.equal(byId.item.fileHash, created.item.fileHash);

  assert.equal((await listRoadmapItems({ tags: ['command center'] })).items.length, 1);
  assert.equal((await listRoadmapItems({ search: 'operator' })).items.length, 1);
  assert.equal((await listRoadmapItems({ project: 'metamask-mobile-farm' })).items.length, 1);
  assert.equal((await listRoadmapItems({ stage: 'refined' })).items.length, 0);
});

test('roadmap store rejects stale edits and accepts matching hash updates', async () => {
  const { getRoadmapItem, saveRoadmapItem } = await store();
  const created = await saveRoadmapItem({
    item: {
      project: 'farmslot-farm',
      targetProjects: ['metamask-mobile-farm', 'metamask-extension-farm'],
      title: 'Refine terminal brainstorming',
      stage: 'rough',
      tags: ['runner'],
      body: 'Initial body.',
    },
  });

  await assert.rejects(
    () =>
      saveRoadmapItem({
        expectedHash: 'stale-hash',
        item: {
          id: created.item.id,
          project: 'farmslot-farm',
          title: 'Refine terminal brainstorming',
          stage: 'refined',
          body: refinedBody(),
        },
      }),
    /changed on disk/,
  );

  const updated = await saveRoadmapItem({
    expectedHash: created.item.fileHash,
    item: {
      id: created.item.id,
      project: 'farmslot-farm',
      title: 'Refine terminal brainstorming',
      stage: 'refined',
      tags: ['runner', 'Roadmap'],
      body: refinedBody(),
    },
  });

  assert.equal(updated.item.stage, 'refined');
  assert.deepEqual(updated.item.tags, ['roadmap', 'runner']);
  assert.match(updated.item.body, /Updated body/);
  assert.equal(
    (await getRoadmapItem({ itemId: created.item.id })).item.fileHash,
    updated.item.fileHash,
  );
});

test('roadmap store requires refined items to carry planning and acceptance criteria sections', async () => {
  const { saveRoadmapItem } = await store();
  await assert.rejects(
    () =>
      saveRoadmapItem({
        item: {
          project: 'farmslot-farm',
          title: 'Incomplete refined idea',
          stage: 'refined',
          body: 'Only a sentence.',
        },
      }),
    /Refined roadmap items require sections/,
  );
});

test('roadmap store writes project-scoped items and moves assigned inbox items by project', async () => {
  const { saveRoadmapItem } = await store();

  const projectItem = await saveRoadmapItem({
    item: {
      project: 'farmslot-farm',
      title: 'Project-scoped idea',
      body: 'Project note.',
    },
  });
  assert.match(
    projectItem.item.filePath,
    /projects\/farmslot-farm\/items\/\d{4}-\d{2}-\d{2}-project-scoped-idea\.md$/,
  );

  const inboxItem = await saveRoadmapItem({
    item: {
      title: 'Assign me later',
      body: 'Inbox note.',
    },
  });
  const oldPath = path.join(farmslotRoot, inboxItem.item.filePath);

  const assigned = await saveRoadmapItem({
    expectedHash: inboxItem.item.fileHash,
    item: {
      id: inboxItem.item.id,
      project: 'farmslot-farm',
      title: 'Assign me later',
      body: 'Assigned note.',
    },
  });

  assert.match(
    assigned.item.filePath,
    /projects\/farmslot-farm\/items\/\d{4}-\d{2}-\d{2}-assign-me-later\.md$/,
  );
  assert.equal(existsSync(path.join(farmslotRoot, assigned.item.filePath)), true);
  assert.equal(existsSync(oldPath), false);
});

test('roadmap store serializes same-title creates into unique indexed item paths', async () => {
  const { listRoadmapItems, saveRoadmapItem } = await store();

  const [first, second] = await Promise.all([
    saveRoadmapItem({
      item: {
        project: 'farmslot-farm',
        title: 'Concurrent roadmap idea',
        body: 'First body.',
      },
    }),
    saveRoadmapItem({
      item: {
        project: 'farmslot-farm',
        title: 'Concurrent roadmap idea',
        body: 'Second body.',
      },
    }),
  ]);

  assert.notEqual(first.item.id, second.item.id);
  assert.notEqual(first.item.filePath, second.item.filePath);
  assert.equal((await listRoadmapItems({ project: 'farmslot-farm' })).items.length, 2);
});

test('roadmap store rejects caller-supplied paths outside indexed item directories', async () => {
  const { listRoadmapItems, saveRoadmapItem } = await store();

  await assert.rejects(
    () =>
      saveRoadmapItem({
        item: {
          project: 'farmslot-farm',
          title: 'Invisible item',
          filePath: path.relative(farmslotRoot, path.join(promptRoot, 'invisible.md')),
          body: 'This would not be indexed by roadmap.list.',
        },
      }),
    /project roadmap item directory/,
  );
  assert.equal((await listRoadmapItems({ includeArchived: true })).items.length, 0);
});

test('roadmap store deletes unpromoted items and rejects promoted deletes', async () => {
  const { deleteRoadmapItem, listRoadmapItems, promoteRoadmapItem, saveRoadmapItem } =
    await store();
  const draft = await saveRoadmapItem({
    item: {
      project: 'farmslot-farm',
      title: 'Delete draft idea',
      body: 'Draft only.',
    },
  });

  await assert.rejects(
    () => deleteRoadmapItem({ itemId: draft.item.id, expectedHash: 'stale-hash' }),
    /changed on disk/,
  );
  await deleteRoadmapItem({ itemId: draft.item.id, expectedHash: draft.item.fileHash });
  assert.equal((await listRoadmapItems({ includeArchived: true })).items.length, 0);
  assert.equal(existsSync(path.join(farmslotRoot, draft.item.filePath)), false);

  const refined = await saveRoadmapItem({
    item: {
      project: 'farmslot-farm',
      title: 'Keep promoted idea',
      stage: 'refined',
      body: refinedBody('Promoted items keep backlog provenance.'),
    },
  });
  const promoted = await promoteRoadmapItem({
    itemId: refined.item.id,
    expectedHash: refined.item.fileHash,
    specs: [
      {
        title: 'Keep promoted backlog spec',
        body: '## Context\n\nKeep it linked.\n\n## Acceptance Criteria\n\n- Linked backlog item survives.',
      },
    ],
  });

  await assert.rejects(
    () =>
      deleteRoadmapItem({
        itemId: promoted.roadmapItem.id,
        expectedHash: promoted.roadmapItem.fileHash,
      }),
    /Promoted roadmap items cannot be deleted/,
  );
});

test('roadmap store excludes archived items unless requested and parses simple human frontmatter', async () => {
  const { listRoadmapItems, saveRoadmapItem } = await store();
  const created = await saveRoadmapItem({
    item: {
      project: 'farmslot-farm',
      title: 'Archived human edit',
      stage: 'archived',
      tags: ['legacy'],
      body: 'Archived note.',
    },
  });
  const absolutePath = path.join(farmslotRoot, created.item.filePath);
  await writeFile(
    absolutePath,
    [
      '---',
      `id: ${created.item.id}`,
      'kind: roadmap-item',
      'project: farmslot-farm',
      'title: Archived human edit',
      'stage: archived',
      'tags: [legacy, raw idea]',
      'createdAt: 2026-06-28T00:00:00.000Z',
      'updatedAt: 2026-06-28T00:00:00.000Z',
      '---',
      '',
      'Archived note.',
    ].join('\n'),
    'utf-8',
  );

  assert.equal((await listRoadmapItems()).items.length, 0);
  const archived = await listRoadmapItems({ includeArchived: true, tags: ['raw idea'] });
  assert.equal(archived.items.length, 1);
  assert.deepEqual(archived.items[0]?.tags, ['legacy', 'raw-idea']);
});

test('roadmap store prepares a tmux refinement prompt without a session database', async () => {
  const { getRoadmapPrompt, getRoadmapRefinementSession, saveRoadmapItem, startRoadmapRefinement } =
    await store();
  const created = await saveRoadmapItem({
    item: {
      project: 'farmslot-farm',
      targetProjects: ['metamask-mobile-farm', 'metamask-extension-farm'],
      title: 'Interactive refinement',
      stage: 'rough',
      tags: ['brainstorm'],
      body: 'Raw thought to refine.',
    },
  });

  const refined = await startRoadmapRefinement({
    itemId: created.item.id,
    expectedHash: created.item.fileHash,
    launch: false,
    runner: 'codex',
    model: 'gpt-5',
    runnerCommand: '{{runner}} --model {{model}} refine {{prompt_path}} --item {{item_file}}',
  });

  assert.equal(refined.item.stage, 'refining');
  assert.equal(refined.launched, false);
  assert.equal(refined.item.refinementPromptPath, refined.promptPath);
  assert.equal(refined.tmuxSession, `roadmap-${created.item.id.replace('_', '-')}`);
  const session = await getRoadmapRefinementSession({ itemId: created.item.id });
  assert.equal(session.tmuxSession, refined.tmuxSession);
  assert.equal(session.exists, false);
  assert.equal(session.tmuxTarget, refined.tmuxSession);
  assert.equal(refined.runner, 'codex');
  assert.equal(refined.model, 'gpt-5');
  assert.equal(
    refined.runnerCommand,
    '{{runner}} --model {{model}} refine {{prompt_path}} --item {{item_file}}',
  );
  assert.match(refined.promptPath, /^\.sandbox\/roadmap-store-test-\d+\/refinement-prompts\//);

  const prompt = await readFile(path.join(farmslotRoot, refined.promptPath), 'utf-8');
  assert.match(prompt, /interactive planning\/refinement session inside the Farmslot/);
  assert.match(prompt, /Only edit the roadmap markdown file after the operator confirms/);
  assert.match(prompt, /Treat `farmslot roadmap --help` as the discoverable command surface/);
  assert.match(prompt, /promotion request command shown below is local\/file-backed/);
  assert.match(prompt, /For GitHub PR URLs, prefer `gh pr view <number>/);
  assert.match(prompt, /## Output contract/);
  assert.match(prompt, /## Acceptance Criteria/);
  assert.match(prompt, /Raw thought to refine/);
  assert.match(prompt, /Refinement runner: codex/);
  assert.match(prompt, /Refinement model: gpt-5/);
  assert.match(prompt, /Target projects: metamask-extension-farm, metamask-mobile-farm/);

  const promptResult = await getRoadmapPrompt({ path: refined.promptPath });
  assert.equal(promptResult.path, refined.promptPath);
  assert.equal(promptResult.absolutePath, path.join(farmslotRoot, refined.promptPath));
  assert.equal(promptResult.content, prompt);
  await assert.rejects(
    () => getRoadmapPrompt({ path: '.roadmap/inbox/items/not-a-prompt.md' }),
    /refinement prompt markdown file/,
  );

  const listed = await (await store()).listRoadmapItems();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0]?.refinementPromptPath, refined.promptPath);
  assert.equal(listed.items[0]?.id, created.item.id);
});

test('roadmap store lists, reads, and saves promotion draft attachments', async () => {
  const { getRoadmapPromotionDraft, listRoadmapPromotionDrafts, saveRoadmapPromotionDraft } =
    await store();
  const draftDir = path.join(roadmapRoot, 'promotion-drafts', 'ri_test');
  const draftPath = path.join(draftDir, '01-mobile.md');
  await mkdir(draftDir, { recursive: true });
  await writeFile(
    draftPath,
    [
      '---',
      'kind: "backlog-spec"',
      'roadmapItemId: "ri_test"',
      'project: "metamask-mobile-farm"',
      '---',
      '',
      '# Mobile follow-up',
      '',
      '## Acceptance Criteria',
      '',
      '- Mobile is updated.',
      '',
    ].join('\n'),
    'utf8',
  );

  const listed = await listRoadmapPromotionDrafts({ itemId: 'ri_test' });
  assert.equal(listed.drafts.length, 1);
  assert.equal(listed.drafts[0]?.path, path.relative(farmslotRoot, draftPath));
  assert.equal(listed.drafts[0]?.filename, '01-mobile.md');

  const loaded = await getRoadmapPromotionDraft({ path: listed.drafts[0]!.path });
  assert.equal(loaded.content, await readFile(draftPath, 'utf8'));
  assert.equal(loaded.contentHash, listed.drafts[0]?.contentHash);
  const saved = await saveRoadmapPromotionDraft({
    path: loaded.path,
    content: loaded.content.replace('Mobile is updated.', 'Mobile draft is saved.'),
    expectedHash: loaded.contentHash,
  });
  assert.match(saved.content, /Mobile draft is saved\./);
  assert.equal(await readFile(draftPath, 'utf8'), saved.content);
  await assert.rejects(
    () =>
      saveRoadmapPromotionDraft({
        path: loaded.path,
        content: loaded.content,
        expectedHash: loaded.contentHash,
      }),
    /changed on disk/,
  );
  await assert.rejects(
    () => getRoadmapPromotionDraft({ path: '.roadmap/inbox/items/not-a-draft.md' }),
    /promotion draft markdown file/,
  );
});

test('roadmap refinement runner command clears ambient tmux context', async () => {
  const { __roadmapStoreTest, saveRoadmapItem } = await store();
  const created = await saveRoadmapItem({
    item: {
      project: 'farmslot-farm',
      title: 'Isolated refinement',
      stage: 'rough',
      body: 'Refine this without inheriting tmux.',
    },
  });

  const command = __roadmapStoreTest.buildRefinementShellCommand(
    created.item,
    '.roadmap/refinement-prompts/example.md',
    '{{runner}} --model {{model}} refine {{prompt_path}} --item {{item_file}}',
    'codex',
    'gpt-5',
  );

  assert.match(command, /cd .* && unset TMUX TMUX_PANE && export FARMSLOT_ROADMAP_REFINEMENT=1/);
  assert.match(command, /export FARMSLOT_RUNNER_SCOPE=roadmap-refinement/);
  assert.match(command, /'codex' --model 'gpt-5' refine/);
  assert.match(command, /--item .*isolated-refinement/);

  const dangerousCommand = __roadmapStoreTest.buildRefinementShellCommand(
    created.item,
    '.roadmap/refinement-prompts/example.md',
    undefined,
    'codex',
    'gpt-5',
    'dangerous',
  );
  assert.match(dangerousCommand, /--dangerously-bypass-approvals-and-sandbox/);
  assert.doesNotMatch(dangerousCommand, /--ask-for-approval on-request/);
});

test('roadmap promotion request command uses configurable farmslot prefix', async () => {
  const { __roadmapStoreTest, saveRoadmapItem } = await store();
  const created = await saveRoadmapItem({
    item: {
      project: 'global',
      targetProjects: ['metamask-mobile-farm', 'metamask-extension-farm'],
      title: 'Promotion command selection',
      stage: 'rough',
      body: 'Check command generation.',
    },
  });
  const oldCommand = process.env.FARMSLOT_COMMAND;
  try {
    process.env.FARMSLOT_COMMAND = 'farmslot';
    const defaultCommand = __roadmapStoreTest.defaultPromotionRequestCommand(created.item);
    assert.match(defaultCommand, /^farmslot roadmap request-promotion /);
    assert.match(
      defaultCommand,
      /--target-projects 'metamask-extension-farm,metamask-mobile-farm'/,
    );
    assert.match(
      defaultCommand,
      /--roadmap-route '#roadmap\?projects=metamask-extension-farm%2Cmetamask-mobile-farm&item=ri_[a-f0-9]{12}'$/,
    );

    process.env.FARMSLOT_COMMAND = 'yarn workspace @farmslot/cli farmslot';
    const envCommand = __roadmapStoreTest.defaultPromotionRequestCommand(created.item);
    assert.match(envCommand, /^yarn workspace @farmslot\/cli farmslot roadmap request-promotion /);

    const configCommand = __roadmapStoreTest.defaultPromotionRequestCommand(
      created.item,
      'yarn dlx @farmslot/cli farmslot',
    );
    assert.match(configCommand, /^yarn dlx @farmslot\/cli farmslot roadmap request-promotion /);
  } finally {
    if (oldCommand === undefined) delete process.env.FARMSLOT_COMMAND;
    else process.env.FARMSLOT_COMMAND = oldCommand;
  }
});

test('roadmap store promotes a refined item into ready backlog markdown specs', async () => {
  const { promoteRoadmapItem, saveRoadmapItem } = await store();
  const backlog = await import('../backlog/store.js');
  const roadmap = await saveRoadmapItem({
    item: {
      project: 'farmslot-farm',
      title: 'Roadmap to backlog flow',
      stage: 'refined',
      tags: ['roadmap'],
      body: refinedBody('Ideas need refinement before dispatch.'),
    },
  });

  const promoted = await promoteRoadmapItem({
    itemId: roadmap.item.id,
    expectedHash: roadmap.item.fileHash,
    specs: [
      {
        title: 'Create roadmap API',
        tags: ['Command Center'],
        body: [
          '## Context',
          '',
          'Implement the markdown-backed API.',
          '',
          '## Acceptance Criteria',
          '',
          '- List, get, save, and promote roadmap items.',
          '- Created backlog specs include provenance.',
          '',
          '## Dispatch Notes',
          '',
          'Keep this independent from ADR generation.',
        ].join('\n'),
      },
    ],
  });

  assert.equal(promoted.roadmapItem.stage, 'promoted');
  assert.equal(promoted.backlogItems.length, 1);
  assert.equal(promoted.backlogItems[0]?.status, 'ready');
  assert.equal(promoted.backlogItems[0]?.roadmapItemId, roadmap.item.id);
  assert.deepEqual(promoted.backlogItems[0]?.tags, ['command-center', 'roadmap']);
  assert.match(
    promoted.specPaths[0] ?? '',
    /^\.sandbox\/roadmap-backlog-specs-\d+\/farmslot-farm\/\d{4}-\d{2}-\d{2}-create-roadmap-api\.md$/,
  );
  assert.equal(promoted.roadmapItem.promotion?.[0]?.backlogItemId, promoted.backlogItems[0]?.id);

  const markdown = await readFile(path.join(farmslotRoot, promoted.specPaths[0]!), 'utf-8');
  assert.match(markdown, /roadmapItemId/);
  assert.match(markdown, /Created backlog specs include provenance/);
  assert.equal(backlog.listBacklogItems({ tags: ['roadmap'] }).items.length, 1);
});

test('roadmap store promotes target project specs into separate project backlogs', async (t) => {
  const { promoteRoadmapItem, saveRoadmapItem } = await store();
  const backlog = await import('../backlog/store.js');
  const mobileProject = `roadmap-mobile-${process.pid}`;
  const extensionProject = `roadmap-extension-${process.pid}`;
  await Promise.all([
    createProjectFixture(t, mobileProject),
    createProjectFixture(t, extensionProject),
  ]);
  const roadmap = await saveRoadmapItem({
    item: {
      project: 'global',
      targetProjects: [mobileProject, extensionProject],
      title: 'Perps analytics client follow-up',
      stage: 'refined',
      tags: ['perps', 'analytics'],
      body: refinedBody('Core changed the shared perps controller analytics API.'),
    },
  });

  const promoted = await promoteRoadmapItem({
    itemId: roadmap.item.id,
    expectedHash: roadmap.item.fileHash,
    specs: [
      {
        project: mobileProject,
        title: 'Update mobile perps analytics',
        body: [
          '## Context',
          '',
          'Apply the controller analytics update in mobile.',
          '',
          '## Acceptance Criteria',
          '',
          '- Mobile uses the controller analytics exports.',
        ].join('\n'),
      },
      {
        project: extensionProject,
        title: 'Update extension perps analytics',
        body: [
          '## Context',
          '',
          'Apply the controller analytics update in extension.',
          '',
          '## Acceptance Criteria',
          '',
          '- Extension uses the controller analytics exports.',
        ].join('\n'),
      },
    ],
  });

  assert.equal(promoted.roadmapItem.stage, 'promoted');
  assert.deepEqual(promoted.backlogItems.map((item) => item.project).sort(), [
    extensionProject,
    mobileProject,
  ]);
  assert.match(promoted.specPaths[0] ?? '', new RegExp(mobileProject));
  assert.match(promoted.specPaths[1] ?? '', new RegExp(extensionProject));
  assert.equal(promoted.roadmapItem.promotion?.[0]?.project, mobileProject);
  assert.equal(promoted.roadmapItem.promotion?.[1]?.project, extensionProject);
  assert.equal(backlog.listBacklogItems({ project: mobileProject }).items.length, 1);
  assert.equal(backlog.listBacklogItems({ project: extensionProject }).items.length, 1);
});

test('roadmap promotion requires spec projects when multiple target projects exist', async () => {
  const { promoteRoadmapItem, saveRoadmapItem } = await store();
  const roadmap = await saveRoadmapItem({
    item: {
      project: 'global',
      targetProjects: ['metamask-mobile-farm', 'metamask-extension-farm'],
      title: 'Ambiguous fan-out',
      stage: 'refined',
      body: refinedBody('Promotion needs a target project per spec.'),
    },
  });

  await assert.rejects(
    () =>
      promoteRoadmapItem({
        itemId: roadmap.item.id,
        expectedHash: roadmap.item.fileHash,
        specs: [
          {
            title: 'Missing project',
            body: '## Context\n\nAmbiguous.\n\n## Acceptance Criteria\n\n- Project is required.',
          },
        ],
      }),
    /Backlog spec project is required/,
  );
});

test('roadmap promotion validates every spec before writing backlog side effects', async () => {
  const { promoteRoadmapItem, saveRoadmapItem } = await store();
  const backlog = await import('../backlog/store.js');
  const roadmap = await saveRoadmapItem({
    item: {
      project: 'farmslot-farm',
      title: 'Partial promotion guard',
      stage: 'refined',
      tags: ['roadmap'],
      body: refinedBody('Promotion should be all-or-nothing for invalid drafts.'),
    },
  });

  await assert.rejects(
    () =>
      promoteRoadmapItem({
        itemId: roadmap.item.id,
        expectedHash: roadmap.item.fileHash,
        specs: [
          {
            title: 'Valid first spec',
            body: [
              '## Context',
              '',
              'A valid spec should not be written when a later draft is invalid.',
              '',
              '## Acceptance Criteria',
              '',
              '- This valid spec is prevalidated.',
            ].join('\n'),
          },
          {
            title: 'Invalid second spec',
            body: '## Context\n\nMissing acceptance criteria.',
          },
        ],
      }),
    /Backlog spec requires a non-empty ## Acceptance Criteria section/,
  );

  assert.equal(backlog.listBacklogItems({ includeArchived: true }).items.length, 0);
  assert.equal(existsSync(backlogSpecRoot), false);
  const stillRefined = await (await store()).getRoadmapItem({ itemId: roadmap.item.id });
  assert.equal(stillRefined.item.stage, 'refined');
  assert.equal(stillRefined.item.promotion, undefined);
});
