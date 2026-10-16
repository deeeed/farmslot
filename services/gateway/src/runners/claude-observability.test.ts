import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  applyClaudeInterruptionProbe,
  buildClaudeInterruptionProbeCommand,
  parseClaudeInterruptionProbe,
  sessionPaneMoveIsSafe,
} from './claude-observability.js';
import type { HookRecord } from './observability-types.js';
import { makeVars } from './test-fixtures.js';

test('Claude session recovery refuses a second live pane for the same persisted session', async () => {
  const safe = await sessionPaneMoveIsSafe(makeVars(), '%3', '%9', async (_vars, target) => target);

  assert.equal(safe, false);
});

test('Claude session recovery permits a pane move after the recorded pane is gone', async () => {
  const safe = await sessionPaneMoveIsSafe(makeVars(), '%3', '%9', async () => null);

  assert.equal(safe, true);
});

test('native interruption refines only the bound parent turn and fails closed on later or incomplete history', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'parent-turn-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const session = 'parent-session';
  const transcript = path.join(dir, session + '.jsonl');
  const now = Date.now();
  const hook: HookRecord = {
    hook_event_name: 'SubagentStop',
    session_id: session,
    rootSessionId: session,
    transcript_path: transcript,
    turnActive: true,
    turnStartedAt: now - 5000,
    observedAt: now,
  };
  const row = (
    type: string,
    offset: number,
    content: unknown,
    extra: Record<string, unknown> = {},
  ) => ({
    type,
    sessionId: session,
    isSidechain: false,
    timestamp: new Date(now + offset).toISOString(),
    promptId: 'parent-prompt',
    message: { role: type, content },
    ...extra,
  });
  const parent = row('user', -5000, [{ type: 'text', text: 'Retained work' }]);
  const interrupt = row('user', -1000, [{ type: 'text', text: '[Request interrupted by user]' }]);
  const write = (records: unknown[]) =>
    writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const probe = (record: HookRecord = hook) => {
    const command = buildClaudeInterruptionProbeCommand(record, session);
    assert(command);
    return parseClaudeInterruptionProbe(
      execFileSync('bash', ['-c', command], { encoding: 'utf8', timeout: 3000 }),
    );
  };
  write([
    parent,
    interrupt,
    row('assistant', -500, [{ type: 'text', text: 'Child' }], { isSidechain: true }),
  ]);
  const accepted = probe();
  assert.equal(accepted.status, 'interrupted');
  const idle = applyClaudeInterruptionProbe(hook, session, accepted);
  assert.equal(idle?.value, 'idle');
  assert.equal(idle?.source, 'signal');
  assert.equal(idle?.turnToken, `${session}:${now - 5000}`);
  assert.equal(hook.turnActive, true, 'observing a native terminal never mutates the hook receipt');
  for (const newer of [
    row('assistant', 1, [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }]),
    row('user', 1, [{ type: 'text', text: 'New parent work' }], { promptId: 'later-prompt' }),
    row(
      'user',
      1,
      [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image' } }],
      { promptId: 'image-prompt' },
    ),
  ]) {
    write([parent, interrupt, newer]);
    const refused = probe();
    assert.equal(refused.status, 'unavailable');
    assert.equal(applyClaudeInterruptionProbe(hook, session, refused)?.value, 'active');
  }
  write([parent, { ...interrupt, promptId: 'new-literal-input' }]);
  assert.equal(
    probe().status,
    'unavailable',
    'a new literal prompt is not a terminal for the earlier prompt',
  );
  write([parent, { ...interrupt, sessionId: 'other-parent' }]);
  assert.equal(probe().status, 'unavailable');
  write([parent, interrupt]);
  assert.equal(probe({ ...hook, turnStartedAt: now }).status, 'unavailable');
  appendFileSync(transcript, '{');
  assert.equal(probe().status, 'unavailable');
  assert.equal(
    buildClaudeInterruptionProbeCommand({ ...hook, rootSessionId: 'other-parent' }, session),
    null,
  );
  assert.equal(
    buildClaudeInterruptionProbeCommand(
      { ...hook, transcript_path: path.join(dir, 'rollout.jsonl') },
      session,
    ),
    null,
  );
  assert.equal(buildClaudeInterruptionProbeCommand({ ...hook, turnActive: false }, session), null);
  assert.throws(
    () => parseClaudeInterruptionProbe('{"status":"interrupted","observedAt":"bad"}'),
    /Invalid native/,
  );
});
