import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildInteractiveRefinementRunnerCommand,
  buildPiLaunch,
  buildRunnerSessionReloadCommand,
  resolveRunnerEffort,
} from './launch-command.js';
import { makeVars } from './test-fixtures.js';

test('an omitted pi effort defaults to high and an explicit level stays selected', () => {
  assert.equal(resolveRunnerEffort('pi', undefined), 'high');
  assert.equal(resolveRunnerEffort('pi', null), 'high');
  assert.equal(resolveRunnerEffort('pi', '  '), 'high');
  assert.equal(resolveRunnerEffort('pi', 'low'), 'low');
  assert.equal(resolveRunnerEffort('pi', 'xhigh'), 'xhigh');
});

test('an omitted pi launch and reload ask for high thinking', () => {
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
    effort: 'xhigh',
  });
  assert.match(explicit ?? '', /--thinking xhigh/);
  const worker = buildPiLaunch({ binary: 'pi', repo: '/tmp/repo', model: 'grok-4.7' });
  assert.match(worker, /--thinking high/);
  assert.match(worker, /FARMSLOT_THINKING='high'/);
  const low = buildPiLaunch({ binary: 'pi', repo: '/tmp/repo', model: 'grok-4.7', effort: 'low' });
  assert.match(low, /--thinking low/);
  const vars = makeVars({ piPath: 'pi' });
  const reload = buildRunnerSessionReloadCommand(vars, 'pi', 'grok-4.7', 'session', {});
  assert.match(reload, /--thinking high/);
});
