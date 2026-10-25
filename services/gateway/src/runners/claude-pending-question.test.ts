import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import '../runtime/mock-pty.test-support.js';

import {
  buildClaudeQuestionProbeCommand,
  readClaudePendingQuestion,
} from './claude-pending-question.js';
import { makeVars } from './test-fixtures.js';

const sessionId = 'owned-session';
const pythonDirectory = path.dirname(
  execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(),
);
const env = { ...process.env, PATH: `${pythonDirectory}${path.delimiter}${process.env.PATH}` };
const question = {
  type: 'assistant',
  sessionId,
  isSidechain: false,
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'ask-1',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which network?',
              options: [{ label: 'Testnet', description: 'Use fixtures' }, { label: 'Mainnet' }],
            },
          ],
        },
      },
    ],
  },
};
const answer = {
  type: 'user',
  sessionId,
  isSidechain: false,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'Testnet' }],
  },
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worker-question-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, `${sessionId}.jsonl`);
  const write = (rows: unknown[]) =>
    writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const probe = (id = sessionId): { known: boolean; question?: string | null } =>
    JSON.parse(
      execFileSync('sh', ['-c', buildClaudeQuestionProbeCommand(id, file)], {
        encoding: 'utf8',
        env,
      }),
    );
  return { file, write, probe };
}

test('unanswered native question exposes its text/options, exact tool result closes it', async (t) => {
  const f = await fixture(t);
  await f.write([question]);
  assert.equal(f.probe().question, 'Which network?\n- Testnet: Use fixtures\n- Mainnet');
  for (const unrelated of [
    { ...answer, sessionId: 'foreign' },
    { ...answer, isSidechain: true },
    {
      ...answer,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'other' }] },
    },
  ]) {
    await f.write([question, unrelated]);
    assert.match(f.probe().question ?? '', /Which network/);
  }
  await f.write([question, answer]);
  assert.deepEqual(
    { known: f.probe().known, question: f.probe().question },
    { known: true, question: null },
  );
});

test('question-looking prose/child tools do not open a question; new root prompt supersedes it', async (t) => {
  const f = await fixture(t);
  const prompt = {
    type: 'user',
    sessionId,
    isSidechain: false,
    message: { role: 'user', content: 'AskUserQuestion: continue?' },
  };
  await f.write([prompt, { ...question, isSidechain: true }]);
  assert.equal(f.probe().question, null);
  await f.write([question, { ...prompt, isMeta: true }]);
  assert.match(f.probe().question ?? '', /Which network/);
  await f.write([question, prompt]);
  assert.equal(f.probe().question, null);
  await f.write([
    {
      ...question,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pwd' } }],
      },
    },
  ]);
  assert.equal(f.probe().known, true);
  assert.equal(
    f.probe().question,
    null,
    'no AskUserQuestion does not establish permission approval',
  );
});

test('partial, missing and foreign transcript observations stay unknown', async (t) => {
  const f = await fixture(t);
  await f.write([question]);
  assert.equal(f.probe('foreign').known, false);
  await writeFile(f.file, JSON.stringify(question));
  assert.equal(f.probe().known, false);
  await f.write([{ ...question, sessionId: 'foreign' }]);
  assert.equal(f.probe().known, false);
  await rm(f.file);
  assert.equal(f.probe().known, false);
});

test('question reader refuses a replaced native process and preserves unknown versus answered', async () => {
  const native = {
    sessionId,
    processPid: '42',
    sessionPath: `/tmp/${sessionId}.jsonl`,
    status: 'waiting' as const,
    observedAt: 1000,
  };
  for (const state of ['open', 'answered', 'unknown', 'replaced', 'foreign'] as const) {
    let reads = 0;
    const observed = await readClaudePendingQuestion(makeVars(), 'worker', {
      process: async () => ({
        ...native,
        processPid: ++reads > 1 && state === 'replaced' ? '43' : '42',
      }),
      exec: async () => ({
        stdout: JSON.stringify({
          known: state !== 'unknown',
          sessionId: state === 'foreign' ? 'foreign' : sessionId,
          observedAt: 1000,
          question: state === 'answered' ? null : 'Which network?',
        }),
        stderr: '',
        exitCode: 0,
      }),
    });
    if (state === 'open') assert.equal(observed?.value, 'Which network?');
    else if (state === 'answered') {
      assert.ok(observed);
      assert.equal(observed.value, null);
    } else assert.equal(observed, null);
  }
});
