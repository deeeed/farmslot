import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { execLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

import {
  buildGrokPromptSignalProbeCommand,
  createGrokLogObservability,
  parseGrokPromptSignalProbe,
} from './grok-observability.js';
import { makeVars } from './test-fixtures.js';

describe('Grok structured prompt observability', () => {
  it('parses a structured session signal', () => {
    assert.deepEqual(
      parseGrokPromptSignalProbe(
        JSON.stringify({
          status: 'matched',
          promptAcceptedAt: 1234,
          activity: 'composing',
          activityAt: 1234,
        }),
      ),
      { status: 'matched', promptAcceptedAt: 1234, activity: 'composing', activityAt: 1234 },
    );
  });

  it('accepts a prompt when the bound Grok session signal advances', async () => {
    const observability = createGrokLogObservability(async (_vars, target, sinceMs, promptText) => {
      assert.equal(target, 'core-3:bugfix');
      assert.equal(sinceMs, 1000);
      assert.equal(promptText, 'Read TASK.md');
      return { status: 'matched', promptAcceptedAt: 1200, activity: 'composing', activityAt: 1200 };
    });

    assert.deepEqual(
      await observability.promptAccepted(
        makeVars(),
        'core-3:bugfix',
        'unused',
        1000,
        false,
        'Read TASK.md',
      ),
      { value: true, source: 'signal', confidence: 'high', observedAt: 1200 },
    );
  });

  it('reports activity from the bound Grok session event stream', async () => {
    const observability = createGrokLogObservability(async () => ({
      status: 'matched',
      promptAcceptedAt: null,
      activity: 'tool-running',
      activityAt: 1300,
    }));

    assert.deepEqual(await observability.getActivity(makeVars(), 'core-3:bugfix'), {
      value: 'tool-running',
      source: 'signal',
      confidence: 'high',
      observedAt: 1300,
    });
  });

  it('captures the provider clock for prompt acceptance cutoffs', async () => {
    const observability = createGrokLogObservability(
      async () => ({
        status: 'matched',
        promptAcceptedAt: null,
        activity: 'idle',
        activityAt: 987_000,
      }),
      async () => 987_654,
    );

    assert.equal(
      await observability.capturePromptAcceptanceBaseline?.(makeVars(), 'core-3:bugfix'),
      987_654,
    );
  });

  it('falls back without a new signal from one pane-bound session', async () => {
    const noChange = createGrokLogObservability(async () => ({
      status: 'matched',
      promptAcceptedAt: null,
      activity: 'idle',
      activityAt: 1000,
    }));
    const ambiguous = createGrokLogObservability(async () => ({ status: 'ambiguous' }));

    assert.equal(
      (
        await noChange.promptAccepted(
          makeVars(),
          'core-3:bugfix',
          'unused',
          1000,
          false,
          'Read TASK.md',
        )
      )?.value,
      false,
    );
    assert.equal(
      await ambiguous.promptAccepted(
        makeVars(),
        'core-3:bugfix',
        'unused',
        1000,
        false,
        'Read TASK.md',
      ),
      null,
    );
  });

  it('executes the generated probe against pane-bound Grok fixtures', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-grok-probe-'));
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    const repo = path.join(root, 'repo');
    const sessionId = 'session-1';
    const prompt = 'Read TASK.md';
    const openedAt = '2026-08-01T12:00:00+00:00';
    const acceptedAt = '2026-08-01T12:00:01+00:00';
    const sessionDir = path.join(home, '.grok', 'sessions', encodeURIComponent(repo), sessionId);
    const activePath = path.join(home, '.grok', 'active_sessions.json');
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');

    try {
      await Promise.all([
        mkdir(bin, { recursive: true }),
        mkdir(repo, { recursive: true }),
        mkdir(sessionDir, { recursive: true }),
      ]);
      const tmuxPath = path.join(bin, 'tmux');
      const psPath = path.join(bin, 'ps');
      const pythonPath = path.join(bin, 'python3');
      await Promise.all([
        writeFile(tmuxPath, "#!/bin/sh\nprintf '111\\n'\n"),
        writeFile(psPath, "#!/bin/sh\nprintf '111 1\\n222 111\\n223 111\\n333 1\\n'\n"),
        writeFile(pythonPath, '#!/bin/sh\nexec /usr/bin/python3 "$@"\n'),
        writeFile(
          activePath,
          JSON.stringify([{ cwd: repo, pid: 222, session_id: sessionId, opened_at: openedAt }]),
        ),
        writeFile(
          eventsPath,
          [
            JSON.stringify({
              type: 'turn_started',
              ts: acceptedAt,
              session_id: sessionId,
              turn_number: 0,
            }),
            JSON.stringify({
              type: 'tool_started',
              ts: '2026-08-01T12:00:01.500+00:00',
              tool_name: 'read_file',
            }),
            '{"partial":',
          ].join('\n'),
        ),
        writeFile(
          chatPath,
          `${JSON.stringify({
            type: 'user',
            prompt_index: 0,
            content: [{ type: 'text', text: prompt }],
          })}\n`,
        ),
      ]);
      await Promise.all([chmod(tmuxPath, 0o755), chmod(psPath, 0o755), chmod(pythonPath, 0o755)]);

      const vars = { ...makeVars(), remoteRepo: repo };
      const runProbe = async () => {
        const command = buildGrokPromptSignalProbeCommand(
          vars,
          'core-3:bugfix',
          Date.parse(openedAt),
          prompt,
        );
        return execLocal(
          `export HOME=${shellQuote(home)}; export PATH=${shellQuote(bin)}:$PATH; ${command}`,
          { cwd: repo },
        );
      };

      const matched = await runProbe();
      assert.equal(matched.exitCode, 0, matched.stderr);
      assert.deepEqual(parseGrokPromptSignalProbe(matched.stdout.trim()), {
        status: 'matched',
        promptAcceptedAt: Date.parse(acceptedAt),
        activity: 'tool-running',
        activityAt: Date.parse('2026-08-01T12:00:01.500+00:00'),
      });

      await writeFile(
        chatPath,
        `${JSON.stringify({
          type: 'user',
          prompt_index: 0,
          content: [{ type: 'text', text: 'Different prompt' }],
        })}\n`,
      );
      await writeFile(
        eventsPath,
        [
          JSON.stringify({
            type: 'turn_started',
            ts: acceptedAt,
            session_id: sessionId,
            turn_number: 0,
          }),
          JSON.stringify({ type: 'turn_ended', ts: '2026-08-01T12:00:02+00:00' }),
        ].join('\n'),
      );
      const idleMismatch = await runProbe();
      assert.deepEqual(parseGrokPromptSignalProbe(idleMismatch.stdout.trim()), {
        status: 'matched',
        promptAcceptedAt: null,
        activity: 'idle',
        activityAt: Date.parse('2026-08-01T12:00:02+00:00'),
      });

      await writeFile(
        activePath,
        JSON.stringify([{ pid: 222, session_id: sessionId, opened_at: openedAt }]),
      );
      const missingCwd = await runProbe();
      assert.deepEqual(parseGrokPromptSignalProbe(missingCwd.stdout.trim()), {
        status: 'unavailable',
      });

      await writeFile(
        activePath,
        JSON.stringify([{ cwd: repo, pid: 333, session_id: sessionId, opened_at: openedAt }]),
      );
      const otherPane = await runProbe();
      assert.deepEqual(parseGrokPromptSignalProbe(otherPane.stdout.trim()), {
        status: 'unavailable',
      });

      await writeFile(
        activePath,
        JSON.stringify([
          { cwd: repo, pid: 222, session_id: sessionId, opened_at: openedAt },
          { cwd: repo, pid: 223, session_id: 'session-2', opened_at: openedAt },
        ]),
      );
      const ambiguous = await runProbe();
      assert.deepEqual(parseGrokPromptSignalProbe(ambiguous.stdout.trim()), {
        status: 'ambiguous',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
