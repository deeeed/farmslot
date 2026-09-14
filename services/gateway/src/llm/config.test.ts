import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getLLMConfig, setLLMConfig } from './config.js';

test('LLM effort defaults are low and explicit settings persist without changing models', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'llm-effort-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  try {
    const initial = getLLMConfig();
    assert.equal(initial.copilotEffort, 'low');
    assert.equal(initial.intelligenceEffort, 'low');
    const updated = setLLMConfig({ intelligenceEffort: 'medium', copilotEffort: 'high' });
    assert.equal(updated.intelligenceModel, initial.intelligenceModel);
    assert.equal(updated.defaultProvider, initial.defaultProvider);
    const stored = JSON.parse(readFileSync(path.join(home, 'llm-config.json'), 'utf8'));
    assert.equal(stored.intelligenceEffort, 'medium');
    assert.equal(stored.copilotEffort, 'high');
    assert.throws(
      () => setLLMConfig({ intelligenceEffort: 'invalid' as 'low' }),
      /invalid reasoning effort/,
    );
    assert.equal(getLLMConfig().intelligenceEffort, 'medium');
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
