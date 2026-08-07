import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildCodexPromptProbeCommand,
  buildCodexSessionIdProbeCommand,
  parseCodexPromptProbe,
} from './codex-observability.js';

const prompt = 'Read SELF-REVIEW-FIX.md';

function record(timestamp: string, text: string): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  });
}

test('Codex native probe validates internal session identity and returns a bounded result', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-codex-session-probe-'));
  const sessionPath = path.join(root, 'rollout-2026-08-06T09-00-00-session-id.jsonl');
  const sessionId = 'session-id';
  const turnId = 'turn-id';
  const acceptedAt = '2026-08-06T09:01:00.000Z';
  try {
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }),
        JSON.stringify({
          timestamp: acceptedAt,
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: turnId },
        }),
        record(acceptedAt, prompt),
      ].join('\n'),
    );

    const idResult = spawnSync('bash', ['-lc', buildCodexSessionIdProbeCommand(sessionPath)], {
      encoding: 'utf8',
    });
    assert.equal(idResult.status, 0, idResult.stderr);
    assert.deepEqual(JSON.parse(idResult.stdout), { sessionId });

    const matched = spawnSync(
      'bash',
      [
        '-lc',
        buildCodexPromptProbeCommand(
          sessionId,
          sessionPath,
          prompt,
          Date.parse('2026-08-06T09:00:30.000Z'),
        ),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(matched.status, 0, matched.stderr);
    assert.deepEqual(parseCodexPromptProbe(matched.stdout.trim()), {
      status: 'matched',
      observedAt: Date.parse(acceptedAt),
      turnId,
    });
    assert.ok(matched.stdout.length < 100, 'probe must return only a compact structured result');

    const mismatch = spawnSync(
      'bash',
      [
        '-lc',
        buildCodexPromptProbeCommand(
          'different-session',
          sessionPath,
          prompt,
          Date.parse('2026-08-06T09:00:30.000Z'),
        ),
      ],
      { encoding: 'utf8' },
    );
    assert.deepEqual(parseCodexPromptProbe(mismatch.stdout.trim()), {
      status: 'identity-mismatch',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
