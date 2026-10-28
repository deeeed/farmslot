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
});
