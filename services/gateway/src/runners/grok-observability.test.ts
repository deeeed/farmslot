import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildGrokPromptSignalProbeCommand,
  createGrokLogObservability,
  parseGrokPromptSignalProbe,
} from './grok-observability.js';
import { makeVars } from './test-fixtures.js';

describe('Grok structured prompt observability', () => {
  it('parses a pane-bound prompt signal', () => {
    assert.deepEqual(
      parseGrokPromptSignalProbe(JSON.stringify({ status: 'matched', promptAcceptedAt: 1234 })),
      { status: 'matched', promptAcceptedAt: 1234 },
    );
  });

  it('accepts a prompt when the bound Grok session signal advances', async () => {
    const observability = createGrokLogObservability(async (_vars, target, sinceMs, promptText) => {
      assert.equal(target, 'core-3:bugfix');
      assert.equal(sinceMs, 1000);
      assert.equal(promptText, 'Read TASK.md');
      return { status: 'matched', promptAcceptedAt: 1200 };
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

  it('captures the provider clock for prompt acceptance cutoffs', async () => {
    const observability = createGrokLogObservability(
      async () => ({ status: 'matched', promptAcceptedAt: null }),
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

  it('bounds the log scan and binds events to the active session process', () => {
    const command = buildGrokPromptSignalProbeCommand(
      makeVars(),
      'core-3:bugfix',
      1000,
      'Read TASK.md',
    );

    assert.match(command, /max_scan_bytes = 1024 \* 1024/);
    assert.match(command, /quote\(repo, safe=''\)/);
    assert.match(command, /quote\(os\.path\.realpath\(repo\), safe=''\)/);
    assert.match(command, /if len\(candidates\) != 1/);
    assert.match(command, /event\.get\('session_id'\) != candidate\['session_id'\]/);
    assert.match(command, /event_ms < max\(candidate\['opened_at_ms'\], since_ms\)/);
    assert.match(command, /event\.get\('prompt'\) == expected_prompt/);
  });
});
