import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildClaudeSessionDiscoveryCommand } from './claude-observability.js';

test('Claude usage discovery separates initial/fix sessions from reviewers and later tasks', (t) => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'claude-usage-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  const root = path.join(home, '.claude/projects', repo.replaceAll('/', '-'));
  mkdirSync(root, { recursive: true });
  const task = 'temp/tasks/fix/owned-task';
  const session = (id: string, timestamp: string, prompt = `Read ${task}/TASK.md`, cwd = repo) => {
    const file = path.join(root, `${id}.jsonl`);
    writeFileSync(
      file,
      JSON.stringify({ type: 'user', timestamp, cwd, message: { role: 'user', content: prompt } }) +
        '\n',
    );
    return file;
  };
  const initial = session('initial', '2026-10-29T01:01:00Z');
  const fix = session('fix', '2026-10-29T01:21:00Z', `Read ${task}/REVIEW-FIX.md`);
  session('reviewer', '2026-10-29T01:11:00Z');
  session('later', '2026-10-29T01:31:00Z');
  session('wrong-task', '2026-10-29T01:22:00Z', `Read ${task}-other/TASK.md`);
  session('other-checkout', '2026-10-29T01:22:00Z', undefined, path.join(home, 'other'));
  const output = execFileSync(
    'bash',
    [
      '-c',
      buildClaudeSessionDiscoveryCommand(repo, home, {
        taskDir: task,
        startedAt: Date.parse('2026-10-29T01:00:00Z'),
        endedAt: Date.parse('2026-10-29T01:30:00Z'),
        reviewerIntervals: [
          {
            startedAt: Date.parse('2026-10-29T01:10:00Z'),
            endedAt: Date.parse('2026-10-29T01:20:00Z'),
          },
        ],
      }),
    ],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: '' } },
  );
  assert.deepEqual(JSON.parse(output).sort(), [initial, fix].sort());
});
