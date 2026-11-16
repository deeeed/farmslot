import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildInteractiveRefinementRunnerCommand,
  buildPiLaunch,
  buildRunnerSessionReloadCommand,
  resolveRunnerEffort,
} from './launch-command.js';
import { makeVars } from './test-fixtures.js';

test('pi review effort defaults to high and a worker keeps medium', () => {
  assert.equal(resolveRunnerEffort('pi', undefined), 'medium');
  assert.equal(resolveRunnerEffort('pi', null, 'dev'), 'medium');
  assert.equal(resolveRunnerEffort('pi', '  ', 'review-fix'), 'medium');
  assert.equal(resolveRunnerEffort('pi', undefined, 'review'), 'high');
  assert.equal(resolveRunnerEffort('pi', 'low', 'review'), 'low');
});

test('an omitted pi review launch asks for high thinking and a worker launch stays medium', () => {
  const review = buildInteractiveRefinementRunnerCommand({
    runner: 'pi',
    repo: '/tmp/review.source',
    promptPath: '/tmp/task/prompt.txt',
    model: 'grok-4.7',
    workspaceTrust: 'untrusted',
  });
  assert.match(review ?? '', /--thinking high/);
  assert.match(review ?? '', /FARMSLOT_THINKING='high'/);
  const explicit = buildInteractiveRefinementRunnerCommand({
    runner: 'pi',
    repo: '/tmp/review.source',
    promptPath: '/tmp/task/prompt.txt',
    model: 'grok-4.7',
    workspaceTrust: 'untrusted',
    effort: 'low',
  });
  assert.match(explicit ?? '', /--thinking low/);
  const worker = buildPiLaunch({ binary: 'pi', repo: '/tmp/repo', model: 'grok-4.7' });
  assert.match(worker, /--thinking medium/);
  assert.match(worker, /FARMSLOT_THINKING='medium'/);
  const vars = makeVars({ piPath: 'pi' });
  const reviewReload = buildRunnerSessionReloadCommand(vars, 'pi', 'grok-4.7', 'session', {
    role: 'review',
  });
  assert.match(reviewReload, /--thinking high/);
  const workerReload = buildRunnerSessionReloadCommand(vars, 'pi', 'grok-4.7', 'session', {});
  assert.match(workerReload, /--thinking medium/);
});
