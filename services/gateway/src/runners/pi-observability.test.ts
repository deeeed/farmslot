import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPiSessionDiscoveryCommand } from './pi-observability.js';

test('Pi discovery and role recovery separate the real worker and later fix session in one pane', (t) => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pi-session-binding-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  const sessionDir = path.join(home, '.pi', 'agent', 'sessions', '--repo--');
  const obs = path.join(home, 'observability');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(path.join(obs, 'sessions'), { recursive: true });
  const fixture = readFileSync(
    new URL('../../../../packages/slot-config/test/fixtures/pi-session.jsonl', import.meta.url),
    'utf8',
  )
    .trim()
    .split('\n')
    .slice(1)
    .join('\n');
  function session(id: string, timestamp: string, cwd = repo, pane = '%7') {
    const file = path.join(sessionDir, `${id}.jsonl`);
    writeFileSync(
      file,
      JSON.stringify({ type: 'session', id, timestamp, cwd }) + '\n' + fixture + '\n',
    );
    writeFileSync(
      path.join(obs, 'sessions', `${encodeURIComponent(id)}.json`),
      JSON.stringify({
        session_id: id,
        runner: 'pi',
        tmuxPane: pane,
        slotId: 'test-slot',
        cwd,
      }),
    );
    return file;
  }
  const worker = session('worker', '2026-10-28T12:56:59.228Z');
  const fix = session('fix', '2026-10-28T14:04:59.046Z');
  const secondFix = session('second-fix', '2026-10-28T14:45:39.189Z');
  session('pi-reviewer', '2026-10-28T14:42:00.000Z');
  session('next-task', '2026-10-28T16:00:00.000Z');
  session('foreign', '2026-10-28T12:57:00.000Z', path.join(home, 'other-repo'));
  session('other-pane', '2026-10-28T12:57:01.000Z', repo, '%8');
  const run = (scope: Parameters<typeof buildPiSessionDiscoveryCommand>[1]) =>
    JSON.parse(
      execFileSync(
        'bash',
        ['-c', buildPiSessionDiscoveryCommand(repo, { homeRoot: home, ...scope })],
        { encoding: 'utf8' },
      ),
    );
  assert.ok(run({}).includes(fix));
  const scope = {
    observabilityDir: obs,
    paneId: '%7',
    slotId: 'test-slot',
    startedAt: Date.parse('2026-10-28T12:56:57.423Z'),
    endedAt: Date.parse('2026-10-28T13:56:24.953Z'),
  };
  assert.deepEqual(run(scope), [worker]);
  assert.deepEqual(run({ ...scope, slotId: 'different-slot' }), []);
  assert.deepEqual(
    run({
      ...scope,
      startedAt: Date.parse('2026-10-28T14:04:57.484Z'),
      endedAt: Date.parse('2026-10-28T14:10:00Z'),
    }),
    [fix],
  );
  assert.deepEqual(
    run({
      ...scope,
      startedAt: Date.parse('2026-10-28T14:04:57.484Z'),
      endedAt: Date.parse('2026-10-28T14:57:36.409Z'),
      reviewerIntervals: [
        {
          startedAt: Date.parse('2026-10-28T14:40:45.947Z'),
          endedAt: Date.parse('2026-10-28T14:45:36.284Z'),
        },
      ],
    }),
    [fix, secondFix],
  );
});

test('released Pi sessions bind to their first native task prompt after pane snapshots are gone', (t) => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pi-retained-task-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  const sessions = path.join(home, '.pi', 'agent', 'sessions', '--repo--');
  const observabilityDir = path.join(home, 'observability');
  const taskDir = 'temp/tasks/feat/owned-task';
  mkdirSync(sessions, { recursive: true });
  mkdirSync(path.join(observabilityDir, 'sessions'), { recursive: true });
  const ownPrompt = `Read the feedback, then use \`${taskDir}/mark\` for this task.`;
  function session(
    id: string,
    timestamp: string,
    prompt = ownPrompt,
    cwd = repo,
    laterPrompt?: string,
  ) {
    const file = path.join(sessions, `${id}.jsonl`);
    const records = [
      { type: 'session', id, timestamp, cwd },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
    ];
    if (laterPrompt)
      records.push({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: laterPrompt }] },
      });
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    return file;
  }
  const initial = session('initial', '2026-10-28T12:56:59.228Z');
  const fix1 = session('fix1', '2026-10-28T14:04:59.046Z');
  const fix2 = session('fix2', '2026-10-28T14:45:39.189Z');
  session('different-task', '2026-10-28T14:06:00Z', 'Use temp/tasks/feat/another/mark');
  session('prefix-task', '2026-10-28T14:07:00Z', `Use ${taskDir}-other/mark`);
  session('suffix-command', '2026-10-28T14:08:00Z', `Use ${taskDir}/mark-other`);
  session('later-mention', '2026-10-28T14:09:00Z', 'Unrelated task', repo, ownPrompt);
  session('bare-mark', '2026-10-28T14:12:00Z', 'Run ./mark');
  session('reviewer', '2026-10-28T14:42:00Z');
  session('future', '2026-10-28T15:00:00Z');
  session('other-cwd', '2026-10-28T14:10:00Z', ownPrompt, path.join(home, 'other'));
  session('conflicting-pane', '2026-10-28T14:11:00Z');
  writeFileSync(
    path.join(observabilityDir, 'sessions', 'conflicting-pane.json'),
    JSON.stringify({
      session_id: 'conflicting-pane',
      runner: 'pi',
      tmuxPane: '%8',
      slotId: 'test-slot',
      cwd: repo,
    }),
  );
  const scope = {
    homeRoot: home,
    observabilityDir,
    taskDir,
    paneId: '%7',
    slotId: 'test-slot',
    startedAt: Date.parse('2026-10-28T12:56:57.423Z'),
    endedAt: Date.parse('2026-10-28T14:57:36.409Z'),
    reviewerIntervals: [
      {
        startedAt: Date.parse('2026-10-28T14:40:45.947Z'),
        endedAt: Date.parse('2026-10-28T14:45:36.284Z'),
      },
    ],
  };
  const read = (input: Parameters<typeof buildPiSessionDiscoveryCommand>[1]) =>
    JSON.parse(
      execFileSync('bash', ['-c', buildPiSessionDiscoveryCommand(repo, input)], {
        encoding: 'utf8',
      }),
    );
  assert.deepEqual(read(scope), [initial, fix1, fix2].sort());
  assert.deepEqual(read({ ...scope, taskDir: undefined }), []);
  assert.deepEqual(read({ ...scope, taskDir: '.' }), []);
});
