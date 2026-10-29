import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { prepareRunnerDispatchPrompt } from './registry.js';
import { makeVars } from './test-fixtures.js';

const vars = makeVars();
const message = 'Read and execute TASK.md in the selected task directory.';

test('Codex dispatch sends a file pointer and preserves the complete task path and instruction', async (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), 'codex-dispatch-prompt-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const taskDir = 'temp/tasks/feat/tat-3216-round5-terra-1028-144606';
  const fullPrompt = `Read ${taskDir}/TASK.md first.\n${'Follow every task requirement.\n'.repeat(200)}Keep the final instruction: café.`;
  const pointer = await prepareRunnerDispatchPrompt(
    { ...vars, remoteRepo: repo },
    'codex',
    fullPrompt,
    taskDir,
  );
  assert.equal(pointer, `Read "${taskDir}/DISPATCH-PROMPT.md" and follow its instructions.`);
  assert.ok(pointer.length < 160, 'the interactive stream contains only a short pointer');
  assert.equal(await readFile(path.join(repo, taskDir, 'DISPATCH-PROMPT.md'), 'utf8'), fullPrompt);
  assert.equal((await stat(path.join(repo, taskDir, 'DISPATCH-PROMPT.md'))).mode & 0o777, 0o600);
});

test('dispatch keeps other runners inline and does not write a prompt file', async () => {
  assert.equal(
    await prepareRunnerDispatchPrompt(vars, 'claude', message, '/missing/task'),
    message,
  );
});

test('Codex dispatch handles an absolute task directory without rebasing it under the repository', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-dispatch-absolute-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pointer = await prepareRunnerDispatchPrompt(vars, 'codex', message, dir);
  assert.equal(
    pointer,
    `Read ${JSON.stringify(path.join(dir, 'DISPATCH-PROMPT.md'))} and follow its instructions.`,
  );
  assert.equal(await readFile(path.join(dir, 'DISPATCH-PROMPT.md'), 'utf8'), message);
});

test('Codex dispatch refuses a failed prompt write instead of sending an inline fallback', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-dispatch-write-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blocked = path.join(dir, 'not-a-directory');
  await writeFile(blocked, 'retained');
  await assert.rejects(prepareRunnerDispatchPrompt(vars, 'codex', message, blocked), {
    code: 'EEXIST',
  });
  assert.equal(await readFile(blocked, 'utf8'), 'retained');
});
