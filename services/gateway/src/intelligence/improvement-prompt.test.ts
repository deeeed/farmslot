import assert from 'node:assert/strict';
import test from 'node:test';

import { improvementSystemPrompt } from './improvement-prompt.js';

test('the engine prompt names the source run so the learning can be verified against its evidence', () => {
  const prompt = improvementSystemPrompt('RULES', '- a learning', 'demo-farm', 'run-123');
  assert.ok(
    prompt.startsWith('RULES\n\n## Current Learning\n- a learning\n\n## Project\ndemo-farm'),
  );
  assert.match(prompt, /## Run\nrun-123: .*read_task_file \(run_id "run-123"/);
});
