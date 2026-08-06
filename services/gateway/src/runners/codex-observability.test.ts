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
  promptAcceptedFromCodexSession,
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

test('Codex native session history accepts the exact post-baseline prompt', () => {
  const before = '2026-08-06T09:00:00.000Z';
  const after = '2026-08-06T09:01:00.000Z';
  const reading = promptAcceptedFromCodexSession(
    [`partial-json`, record(before, prompt), record(after, prompt)].join('\n'),
    prompt,
    Date.parse('2026-08-06T09:00:30.000Z'),
  );

  assert.deepEqual(reading, {
    value: true,
    source: 'signal',
    confidence: 'high',
    observedAt: Date.parse(after),
    exactPromptMatch: true,
  });
});

test('Codex native session history rejects old and non-exact prompts', () => {
  const raw = [
    record('2026-08-06T09:00:00.000Z', prompt),
    record('2026-08-06T09:02:00.000Z', `${prompt} please`),
  ].join('\n');

  assert.equal(
    promptAcceptedFromCodexSession(raw, prompt, Date.parse('2026-08-06T09:01:00.000Z')),
    null,
  );
});

test('Codex native probe validates internal session identity and returns a bounded result', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-codex-session-probe-'));
  const sessionPath = path.join(root, 'rollout-2026-08-06T09-00-00-session-id.jsonl');
  const sessionId = 'session-id';
  const acceptedAt = '2026-08-06T09:01:00.000Z';
  try {
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }),
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
