import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { makeVars } from './test-fixtures.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'claude-native-idle-'));
const prior = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = root;
const tmux = await import('../core/tmux.js');
mock.module('../core/tmux.js', {
  namedExports: {
    ...tmux,
    resolveTmuxPaneId: async () => '%fixture',
    resolveExactTmuxWindowPane: async () => ({ paneId: '%fixture', panePid: String(process.pid) }),
  },
});
const { claudeHookObservability } = await import('./claude-observability.js');
const { readClaudeBackgroundWorkState } = await import('./claude-background-work.js');

test('a hookless workspace reviewer proves native idle without inventing a posting refusal', async (t) => {
  const file = path.join(root, 'claude');
  await writeFile(file, 'setInterval(() => {}, 10000);\n');
  const child = spawn(process.execPath, [file], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
    await rm(root, { recursive: true, force: true });
  });
  await once(child, 'spawn');
  assert(child.pid);
  const sessionId = 'hookless-review-session';
  const transcript = path.join(root, 'projects', 'fixture', `${sessionId}.jsonl`);
  await mkdir(path.dirname(transcript), { recursive: true });
  await mkdir(path.join(root, 'sessions'));
  const now = Date.now();
  await writeFile(
    path.join(root, 'sessions', `${child.pid}.json`),
    JSON.stringify({
      pid: child.pid,
      sessionId,
      cwd: root,
      startedAt: now,
      status: 'idle',
      statusUpdatedAt: now,
    }),
  );
  await writeFile(
    transcript,
    JSON.stringify({ type: 'assistant', sessionId, message: { content: [] } }) + '\n',
  );
  const vars = makeVars({ remoteRepo: root, repo: root });
  const turn = await claudeHookObservability.getTurnState?.(vars, 'fixture');
  assert.equal(turn?.value, 'idle');
  assert.equal(turn?.source, 'signal');
  const background = await readClaudeBackgroundWorkState(vars, 'fixture');
  assert.equal(background.value, 'idle');
  assert.equal(background.confidence, 'high');
});
