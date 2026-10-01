import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildClaudeSessionDiscoveryCommand,
  claudeHookObservability,
} from './claude-observability.js';
import { makeVars } from './test-fixtures.js';

test('exact resume arguments reject prompt spoofing and session forks without an open transcript', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-resume-coherence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = 'saved-conversation';
  const transcript = path.join(directory, id + '.jsonl');
  const executable = path.join(directory, 'claude');
  await writeFile(executable, 'setInterval(()=>{},1000);');
  await writeFile(transcript, '{}\n');
  const cases: Array<[string[], boolean]> = [
    [['--resume', id], true],
    [['--model', 'opus', '--resume', id], true],
    [['--resume', 'other', '--append-system-prompt', '--resume ' + id], false],
    [['--system-prompt', '--resume', id], false],
    [['--resume', id, '--fork-session'], false],
    [['--resume', id, '--session-id', 'other'], false],
  ];
  for (const [args, expected] of cases) {
    const child = spawn(process.execPath, [executable, ...args], { stdio: 'ignore' });
    await once(child, 'spawn');
    try {
      const result = await claudeHookObservability.verifyResumedSessionBinding!(
        makeVars({ repo: directory, remoteRepo: directory }),
        String(child.pid),
        id,
        transcript,
      );
      assert.equal(result.ok, expected, JSON.stringify(args));
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
});

test('session discovery honors custom configuration, canonical roots and mtime order', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-discovery_'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repo_with_underscore');
  const config = path.join(directory, 'configuration');
  const projects = path.join(config, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(projects, { recursive: true });
  const paths = ['older', 'newer'].map((name) => path.join(projects, name + '.jsonl'));
  for (const file of paths) await writeFile(file, '{}\n');
  await utimes(paths[0], 1000, 1000);
  await utimes(paths[1], 2000, 2000);
  const actual = JSON.parse(
    execFileSync('bash', ['-c', buildClaudeSessionDiscoveryCommand(repo, directory)], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: config },
    }),
  );
  assert.deepEqual(actual, [await realpath(paths[1]), await realpath(paths[0])]);
});
