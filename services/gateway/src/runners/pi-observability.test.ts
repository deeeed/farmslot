import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writePiReasoningReceipt } from '../../../../scripts/runners/pi-farmslot-hook-writer.mjs';

import {
  buildPiPromptAcceptanceCommand,
  buildPiReasoningReceiptCommand,
  buildPiSessionDiscoveryCommand,
  parsePiReasoningReceipt,
} from './pi-observability.js';

test('Pi request receipts fence the model, attempt, cwd and either transport session identity', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pi-reasoning-receipt-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'timestamp_saved-pi.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session', id: 'saved-pi', cwd: root }) + '\n');
  const since = Date.now() - 1000;
  const read = (sessionId = 'saved-pi', model = 'litellm/glm', cwd = root, started = since) =>
    parsePiReasoningReceipt(
      JSON.parse(
        execFileSync(
          'bash',
          [
            '-c',
            buildPiReasoningReceiptCommand(cwd, {
              sessionId,
              sessionPath: file,
              model,
              since: started,
            }),
          ],
          { encoding: 'utf8' },
        ),
      ),
    );
  assert.equal(read(), null);
  writePiReasoningReceipt(file, {
    provider: 'litellm',
    model: 'glm',
    effectiveReasoning: { mode: 'omitted' },
  });
  assert.equal(read()?.reasoning.mode, 'omitted');
  assert.equal(read('timestamp_saved-pi')?.sessionId, 'timestamp_saved-pi');
  assert.equal(read('foreign-session'), null);
  assert.equal(read('saved-pi', 'litellm/other'), null);
  assert.equal(read('saved-pi', 'litellm/glm', path.join(root, 'other')), null);
  assert.equal(read('saved-pi', 'litellm/glm', root, Date.now() + 1000), null);
  const filePath = `${file}.farmslot-request.json`;
  const malformed = JSON.parse(readFileSync(filePath, 'utf8'));
  malformed.reasoning = { mode: 'off' };
  writeFileSync(filePath, JSON.stringify(malformed));
  assert.equal(read(), null);
  writeFileSync(`${file}.farmslot-request.json`, '{');
  assert.equal(read(), null);
});

test('Pi startup accepts only the exact latest native user message in its saved session', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pi-native-acceptance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const header = { type: 'session', id: 'saved-pi', cwd: root };
  const prompt = 'Continue the saved review\nRead the new TASK.md';
  const message = (text: string, timestamp = '2026-11-12T19:00:01Z', role = 'user') => ({
    type: 'message',
    id: 'input',
    timestamp,
    message: { role, content: [{ type: 'text', text }] },
  });
  const write = (rows: unknown[]) =>
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const read = (id = 'saved-pi', cwd = root) =>
    JSON.parse(
      execFileSync(
        'bash',
        [
          '-c',
          buildPiPromptAcceptanceCommand(cwd, id, file, prompt, Date.parse('2026-11-12T19:00:00Z')),
        ],
        { encoding: 'utf8' },
      ),
    );
  write([header, message(prompt)]);
  assert.equal(read().accepted, true);
  assert.deepEqual(read('another-session'), {});
  assert.deepEqual(read('saved-pi', path.join(root, 'foreign')), {});
  write([header, message(prompt, '2026-11-12T18:59:59Z')]);
  assert.deepEqual(read(), {});
  write([header, message(prompt, undefined, 'toolResult')]);
  assert.deepEqual(read(), {});
  write([header, message(prompt), message(prompt + '\nLater input')]);
  assert.equal(read().accepted, false);
  write([header, message(prompt)]);
  writeFileSync(file, readFileSync(file, 'utf8').trimEnd());
  assert.deepEqual(read(), {});
});

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

test('slotless review discovery requires its exact first task prompt and launch interval', (t) => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pi-review-task-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'workspace/source');
  const taskDir = path.join(home, 'workspace/task');
  const sessions = path.join(home, '.pi/agent/sessions/review');
  mkdirSync(sessions, { recursive: true });
  function session(id: string, prompt: string, timestamp = '2026-11-10T14:52:50Z', cwd = repo) {
    const file = path.join(sessions, `${id}.jsonl`);
    writeFileSync(
      file,
      [
        { type: 'session', id, timestamp, cwd },
        { type: 'message', message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
        {
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: `Read ${taskDir}/TASK.md` }] },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    return file;
  }
  const owned = session('owned', `Read ${taskDir}/TASK.md`);
  const native = JSON.parse(readFileSync(owned, 'utf8').split('\n')[0]);
  native.id = 'native-conversation';
  const records = readFileSync(owned, 'utf8').split('\n');
  records[0] = JSON.stringify(native);
  writeFileSync(owned, records.join('\n'));
  session('foreign-task', 'Read /other/task/TASK.md');
  session('prefix', `Read ${taskDir}-other/TASK.md`);
  session('before-launch', `Read ${taskDir}/TASK.md`, '2026-11-10T14:00:00Z');
  session('after-completion', `Read ${taskDir}/TASK.md`, '2026-11-10T16:00:00Z');
  session('foreign-cwd', `Read ${taskDir}/TASK.md`, undefined, '/other/source');
  assert.deepEqual(
    JSON.parse(
      execFileSync(
        'bash',
        [
          '-c',
          buildPiSessionDiscoveryCommand(repo, {
            homeRoot: home,
            taskDir,
            startedAt: Date.parse('2026-11-10T14:52:46Z'),
            endedAt: Date.parse('2026-11-10T15:01:00Z'),
          }),
        ],
        { encoding: 'utf8' },
      ),
    ),
    [owned],
  );
  assert.deepEqual(
    JSON.parse(
      execFileSync(
        'bash',
        [
          '-c',
          buildPiSessionDiscoveryCommand(repo, {
            homeRoot: home,
            taskDir,
            startedAt: Date.parse('2026-11-10T14:52:46Z'),
            endedAt: Date.parse('2026-11-10T15:01:00Z'),
            bindings: true,
          }),
        ],
        { encoding: 'utf8' },
      ),
    ),
    [{ runnerSessionId: 'native-conversation', runnerSessionPath: owned }],
  );
});
