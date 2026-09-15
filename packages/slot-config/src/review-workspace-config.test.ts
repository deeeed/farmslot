import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = await mkdtemp(path.join(tmpdir(), 'review-workspace-config-'));
process.env.FARMSLOT_PROJECTS_DIR = root;
const { loadProjectVars, normalizeRawReviewWorkspaces, normalizeRawStaticReview } =
  await import('./config.js');
after(() => rm(root, { recursive: true, force: true }));

test('machine reviewer capacity requires an explicit positive integer limit', () => {
  assert.equal(normalizeRawReviewWorkspaces(undefined, 'machine.json'), undefined);
  assert.deepEqual(normalizeRawReviewWorkspaces({ max_concurrent: 3 }, 'machine.json'), {
    maxConcurrent: 3,
  });
  for (const raw of [
    null,
    [],
    true,
    {},
    { max_concurrent: 0 },
    { max_concurrent: -1 },
    { max_concurrent: 1.5 },
    { max_concurrent: '3' },
    { max_concurrent: NaN },
    { max_concurrent: Infinity },
    { max_concurrent: Number.MAX_SAFE_INTEGER + 1 },
    { max_concurrent: 3, root: '/operator/path' },
  ]) {
    assert.throws(
      () => normalizeRawReviewWorkspaces(raw, 'machine.json'),
      /machine.json: review_workspaces/,
    );
  }
});

test('static-review config preserves fixture guidance and accepts a catalog id', () => {
  assert.equal(normalizeRawStaticReview(undefined, 'project.json'), undefined);
  assert.deepEqual(normalizeRawStaticReview({}, 'project.json'), {});
  assert.deepEqual(normalizeRawStaticReview({ instruction_files: ['review.md'] }, 'project.json'), {
    instructionFiles: ['review.md'],
  });
  assert.deepEqual(
    normalizeRawStaticReview(
      {
        template_id: 'team/perps-review',
        instruction_files: ['runtime/review.md'],
      },
      'project.json',
    ),
    {
      templateId: 'team/perps-review',
      instructionFiles: ['runtime/review.md'],
    },
  );
});

test('project loader rejects malformed review templates without changing unconfigured projects', async () => {
  const cases = [
    undefined,
    {},
    { instruction_files: ['review.md'] },
    { template_id: 'team/review' },
    null,
    [],
    true,
    { template_id: '' },
    { template_id: '  ' },
    { template_id: 7 },
    { template_id: 'team/review ' },
    { template_id: 'team/\nreview' },
    { template_id: null },
    { instruction_files: 'review.md' },
    { instruction_files: [7] },
    { steps: ['review'] },
  ];
  for (const [index, raw] of cases.entries()) {
    const project = `project-${index}`;
    const directory = path.join(root, project);
    await mkdir(directory);
    await writeFile(
      path.join(directory, 'project.json'),
      JSON.stringify({ name: project, static_review: raw }),
    );
    if (index < 4) {
      assert.deepEqual((await loadProjectVars(project)).projectJson.static_review, raw);
    } else {
      await assert.rejects(loadProjectVars(project), /static_review/);
    }
  }
});

test('static review domain and file-only support are validated and detached from input config', () => {
  const raw = {
    domain: 'perps',
    support: {
      skills: [
        {
          name: 'mms-perps-review-pr',
          root: { env: 'PUBLIC_SKILLS' },
          subpath: 'domains/perps/skills/review',
          entry: 'skill.md',
        },
      ],
      libraries: [{ name: 'perps', root: { env: 'TEAM_LIBRARY' } }],
      runtime: { name: 'harness', root: { projectPath: 'installed' }, entry: 'dist/cli.js' },
      environment: { LIBRARY: 'perps={{support}}/libraries/perps' },
    },
  };
  const selected = normalizeRawStaticReview(raw, 'project.json')!;
  assert.equal(selected.domain, 'perps');
  assert.deepEqual(selected.support, raw.support);
  raw.support.skills[0].name = 'changed';
  assert.equal(selected.support?.skills?.[0].name, 'mms-perps-review-pr');
  for (const value of [
    { domain: '../perps' },
    { support: { command: 'npm install' } },
    { support: { runtime: { name: 'tool', root: { env: 'TOOL' }, entry: 'install.sh' } } },
    { support: { skills: [{ name: 'review', root: { env: 'SOURCE' }, entry: '../escape.md' }] } },
    { support: { environment: { NODE_OPTIONS: '--require remote.js' } } },
    { support: { environment: { LIBRARY: '{{unfrozen}}/library' } } },
  ])
    assert.throws(() => normalizeRawStaticReview(value, 'project.json'), /project.json:/);
});
