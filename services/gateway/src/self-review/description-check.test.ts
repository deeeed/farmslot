import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createRun, deleteRun, updateRun } from '../runs/store.js';

import {
  buildDescriptionCheckSection,
  descriptionCheckFindings,
  type DescriptionCheckInput,
} from './description-check.js';
import { expandSelfReviewTemplate } from './templates.js';

const execFileAsync = promisify(execFile);

// TAT-4031's shape: the surface is kept and hidden behind a flag.
const HIDE_BEHIND_FLAG = [
  'diff --git a/src/Home.tsx b/src/Home.tsx',
  '--- a/src/Home.tsx',
  '+++ b/src/Home.tsx',
  '@@ -10 +10 @@',
  '-      <SwapBanner />',
  "+      {isFeatureEnabled('hideSwapBanner') ? null : <SwapBanner />}",
].join('\n');

const REAL_REMOVAL = [
  'diff --git a/src/SwapBanner.tsx b/src/SwapBanner.tsx',
  'deleted file mode 100644',
  '--- a/src/SwapBanner.tsx',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-export const SwapBanner = () => null;',
].join('\n');

const BOTH_STATES = {
  before_after_pairs: [
    { label: 'Home, flag off: banner unchanged', before: 'off-before.png', after: 'off-after.png' },
    { label: 'Home, flag on: banner hidden', before: 'on-before.png', after: 'on-after.png' },
  ],
};

function input(overrides: Partial<DescriptionCheckInput>): DescriptionCheckInput {
  return {
    description: '## Summary\nHide the swap banner behind the hideSwapBanner flag.',
    commitSubjects: ['feat: hide the swap banner behind a flag'],
    diff: HIDE_BEHIND_FLAG,
    evidenceManifest: BOTH_STATES,
    ...overrides,
  };
}

test('a description claiming a removal against a diff that hides it is a finding', () => {
  const findings = descriptionCheckFindings(
    input({ description: '## Removed surfaces\nRemoved the swap banner from Home.' }),
  );
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ['DESCRIPTION_CLAIM_NOT_IN_DIFF'],
  );
  assert.match(findings[0]!.detail, /"## Removed surfaces"/);
  assert.match(findings[0]!.detail, /behind a flag/);
});

test('a commit subject claiming a removal the diff does not make is a finding', () => {
  const findings = descriptionCheckFindings(
    input({ commitSubjects: ['feat: strip the swap banner'], diff: '+// comment only' }),
  );
  assert.equal(findings[0]?.code, 'DESCRIPTION_CLAIM_NOT_IN_DIFF');
  assert.match(findings[0]!.detail, /commit subject/);
});

test('a flag change with evidence for one state only is a finding', () => {
  const findings = descriptionCheckFindings(
    input({ evidenceManifest: { before_after_pairs: [BOTH_STATES.before_after_pairs[1]] } }),
  );
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ['FLAG_STATE_EVIDENCE_MISSING'],
  );
  assert.match(findings[0]!.detail, /"flag off"/);
  assert.doesNotMatch(findings[0]!.detail, /"flag on"/);
  assert.match(
    descriptionCheckFindings(input({ evidenceManifest: null }))[0]!.detail,
    /"flag off" or "flag on"/,
  );
});

test('a pair missing its after shot does not cover its state', () => {
  const findings = descriptionCheckFindings(
    input({
      evidenceManifest: {
        before_after_pairs: [
          { label: 'flag off', before: 'off-before.png' },
          BOTH_STATES.before_after_pairs[1],
        ],
      },
    }),
  );
  assert.equal(findings[0]?.code, 'FLAG_STATE_EVIDENCE_MISSING');
});

test('an accurate description with both flag states, and a real removal, are clean', () => {
  assert.deepEqual(descriptionCheckFindings(input({})), []);
  assert.deepEqual(
    descriptionCheckFindings(
      input({
        description: 'Remove the unused swap banner.',
        commitSubjects: ['chore: remove the swap banner'],
        diff: REAL_REMOVAL,
        evidenceManifest: null,
      }),
    ),
    [],
  );
});

test('the section names the findings and says when the pre-check could not run', () => {
  const withFinding = buildDescriptionCheckSection({
    repo: '/repo',
    taskDir: 'tasks/t1',
    baseBranch: 'main',
    preCheck: [{ code: 'FLAG_STATE_EVIDENCE_MISSING', detail: 'no flag off pair.' }],
  });
  assert.match(withFinding, /^## Description and evidence check/);
  assert.match(withFinding, /git diff origin\/main\.\.\.HEAD/);
  assert.match(withFinding, /cat tasks\/t1\/artifacts\/pr-description\.md/);
  assert.match(withFinding, /- `FLAG_STATE_EVIDENCE_MISSING`: no flag off pair\./);
  for (const code of [
    'DESCRIPTION_CLAIM_NOT_IN_DIFF',
    'DIFF_CHANGE_NOT_DESCRIBED',
    'FLAG_STATE_EVIDENCE_MISSING',
  ]) {
    assert.match(withFinding, new RegExp(`- \`${code}\`:`));
  }
  assert.match(
    buildDescriptionCheckSection({
      repo: '/repo',
      taskDir: 't',
      baseBranch: 'main',
      preCheck: { unavailable: 'could not read the diff against origin/main' },
    }),
    /- Not run: could not read the diff against origin\/main\./,
  );
});

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Farmslot Test',
    '-c',
    'user.email=farmslot-test@example.invalid',
    ...args,
  ]);
  return stdout.trim();
}

test('the rendered self-review runs the pre-check on the slot checkout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-description-check-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  const taskDir = 'temp/tasks/description-check';
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'TAT-4031-LIKE',
    runner: 'claude',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
    await rm(root, { recursive: true, force: true });
  });
  await execFileAsync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  await execFileAsync('git', ['clone', '-q', origin, repo]);
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src/Home.tsx'), 'export const Home = () => <SwapBanner />;\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'base');
  await git(repo, 'push', '-q', 'origin', 'HEAD:main');
  await git(repo, 'checkout', '-q', '-b', 'feat/tat-4031');
  await writeFile(
    path.join(repo, 'src/Home.tsx'),
    "export const Home = () => (isFeatureEnabled('hideSwapBanner') ? null : <SwapBanner />);\n",
  );
  await git(repo, 'commit', '-q', '-am', 'feat: strip the swap banner');
  await mkdir(path.join(repo, taskDir, 'artifacts'), { recursive: true });
  await writeFile(
    path.join(repo, taskDir, 'artifacts/pr-description.md'),
    '## Removed surfaces\n- Swap banner on Home\n',
  );
  await writeFile(
    path.join(repo, taskDir, 'artifacts/evidence-manifest.json'),
    JSON.stringify({ before_after_pairs: [BOTH_STATES.before_after_pairs[1]] }),
  );

  const rendered = await expandSelfReviewTemplate(
    {
      slotId: 'description-check',
      projectName: 'farmslot-farm',
      host: 'localhost',
      machine: 'description-check',
      remoteRepo: repo,
      platform: 'cli',
      session: 'description-check',
      resourceVars: {},
    } as never,
    taskDir,
    run.id,
    'static-code',
  );
  const section = rendered.slice(rendered.indexOf('## Description and evidence check'));
  assert.match(section, /- `DESCRIPTION_CLAIM_NOT_IN_DIFF`: The description claims a removal/);
  assert.match(section, /- `FLAG_STATE_EVIDENCE_MISSING`: .*"flag off"/);
  assert.doesNotMatch(section, /Not run/);
});
