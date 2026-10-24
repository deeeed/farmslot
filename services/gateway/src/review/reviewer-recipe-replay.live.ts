import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import '../runtime/mock-pty.test-support.js';

import { shellQuote } from '../core/tmux.js';
import { farmslotRoot } from '../fleet/state.js';
import { getRun } from '../runs/store.js';

import {
  noteReviewInputsAtLaunch,
  recordReviewedInputs,
  reviewedInputsAwaitingReview,
} from './reviewed-inputs.js';
import { slotWithTask } from './reviewed-inputs.test-support.js';

const execFileAsync = promisify(execFile);
const { reviewerScratchRule } = await import('./review-agent.js');

// Standalone: importing the recipe CLI and probing slot fingerprints exceeds the default test budget.
test('a passing review can replay a recipe without changing its reviewed worker evidence', async (t) => {
  const { run, repo, artifacts } = await slotWithTask(t);
  const task = path.dirname(artifacts);
  const selected = path.join(artifacts, 'latest-valid-recipe-run.json');
  await writeFile(selected, '{"runId":"author"}');
  const ledger = path.join(artifacts, 'acceptance-status.json');
  await writeFile(ledger, '{"schemaVersion":1,"criteria":[]}');
  await noteReviewInputsAtLaunch(run.id);

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'review recipe scratch-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const driver = path.join(scratch, 'recipe.mjs');
  // Run the production recipe CLI allocator; capture output stands in for an app.
  await writeFile(
    driver,
    `import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveRecipeExecutionArtifacts } from ${JSON.stringify(pathToFileURL(path.join(farmslotRoot, 'packages/recipe-cli/src/harness/commands/run.ts')).href)};
const args = process.argv.slice(2);
const flag = args.indexOf('--artifacts-dir');
const explicit = flag < 0 ? undefined : args[flag + 1];
const { taskDir, artifactsDir } = resolveRecipeExecutionArtifacts(args[0], explicit, {
  fresh: 'runs/reviewer', taskSubdir: 'recipe-runs/reviewer',
});


await mkdir(artifactsDir, { recursive: true });
await writeFile(path.join(artifactsDir, 'evidence-manifest.json'), '{"standalone":[{"path":"after.png"}]}');
await writeFile(path.join(artifactsDir, 'after.png'), 'reviewer capture');
if (taskDir) await writeFile(path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'), '{"runId":"reviewer"}');
console.log(JSON.stringify({ taskDir, artifactsDir }));
`,
  );
  const rule = reviewerScratchRule(run.id);
  const wrapper = /```sh\n([\s\S]*?)\n```/.exec(rule)?.[1];
  // Before the fix the contract supplies no wrapper, so the copied worker command binds the task.
  const command = [process.execPath, '--import', import.meta.resolve('tsx'), driver, repo]
    .map(shellQuote)
    .join(' ');
  const { stdout } = await execFileAsync(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      `${wrapper ?? ''}\n${wrapper ? 'reviewer_recipe_replay ' : ''}${command}`,
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: path.join(farmslotRoot, 'services/gateway/tsconfig.json'),
        TMPDIR: scratch,
        RECIPE_TASK_DIR: task,
        FARMSLOT_TASK_DIR: task,
      },
    },
  );
  await recordReviewedInputs(run.id);
  assert.equal(
    await reviewedInputsAwaitingReview(getRun(run.id)!),
    null,
    'the passing replay must not reopen review',
  );
  assert.equal(await readFile(selected, 'utf8'), '{"runId":"author"}');
  assert.equal(await readFile(ledger, 'utf8'), '{"schemaVersion":1,"criteria":[]}');
  const replay: { taskDir: string | null; artifactsDir: string } = JSON.parse(stdout);
  assert.equal(replay.taskDir, null);
  assert.ok(
    replay.artifactsDir.startsWith(path.join(scratch, 'farmslot-review', run.id) + path.sep),
  );
  assert.equal(
    await readFile(path.join(replay.artifactsDir, 'after.png'), 'utf8'),
    'reviewer capture',
  );
});
