import assert from 'node:assert/strict';
import test from 'node:test';

import type { CommandContext } from '../context.js';

import {
  backlogRefineRpcParams,
  formatBacklogRefineOutput,
  formatBacklogRefinementSessionOutput,
  reconcileBacklogItemRun,
  resolveItem,
} from './backlog.js';

function ctxWithItems(items: Array<{ id: string; sourceRef?: string }>): CommandContext {
  return {
    client: { call: async () => ({ items }) },
    output: {},
    target: {},
  } as unknown as CommandContext;
}

test('resolveItem prefers exact sourceRef/id matches', async () => {
  const ctx = ctxWithItems([
    { id: 'aaa111', sourceRef: 'MANUAL-000001' },
    { id: 'aaa222', sourceRef: 'MANUAL-000002' },
  ]);
  assert.equal((await resolveItem(ctx, 'MANUAL-000002')).id, 'aaa222');
  assert.equal((await resolveItem(ctx, 'aaa111')).id, 'aaa111');
});

test('resolveItem rejects ambiguous id prefixes with a teach-the-escape error', async () => {
  const ctx = ctxWithItems([
    { id: 'aaa111', sourceRef: 'MANUAL-000001' },
    { id: 'aaa222', sourceRef: 'MANUAL-000002' },
  ]);
  await assert.rejects(
    () => resolveItem(ctx, 'aaa'),
    (err: unknown) => {
      const rich = err as { code?: string; userAction?: string };
      assert.equal(rich.code, 'BACKLOG_ITEM_AMBIGUOUS');
      assert.ok(rich.userAction && rich.userAction.length > 0);
      return true;
    },
  );
  await assert.rejects(
    () => resolveItem(ctx, 'zzz'),
    (err: unknown) => (err as { code?: string }).code === 'BACKLOG_ITEM_NOT_FOUND',
  );
});

test('reconcileBacklogItemRun calls the shared typed gateway action', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const result = {
    item: { id: 'backlog-1', status: 'done' },
    run: { id: 'run-1', status: 'done' },
  };
  const ctx = {
    client: {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return result;
      },
    },
  } as unknown as CommandContext;

  assert.equal(await reconcileBacklogItemRun(ctx, { id: 'backlog-1' } as never, 'run-1'), result);
  assert.deepEqual(calls, [
    {
      method: 'backlog.reconcileRun',
      params: { itemId: 'backlog-1', runId: 'run-1' },
    },
  ]);
});

test('backlog refine CLI params cover prompt-only and launch modes', () => {
  assert.deepEqual(backlogRefineRpcParams('item-1', {}), { itemId: 'item-1' });
  assert.deepEqual(
    backlogRefineRpcParams('item-1', {
      runner: 'codex',
      model: 'gpt-5.6-sol',
      launch: true,
      runnerCommand: 'codex {{prompt_path}}',
    }),
    {
      itemId: 'item-1',
      runner: 'codex',
      model: 'gpt-5.6-sol',
      runnerCommand: 'codex {{prompt_path}}',
      launch: true,
    },
  );
});

test('backlog refine CLI output distinguishes prepared, launched, and existing session', () => {
  const base = {
    item: { id: 'b1', sourceRef: 'MANUAL-000087' },
    promptPath: '.backlog/refinement-prompts/x.md',
    tmuxSession: 'backlog-manual-000087',
    tmuxTarget: 'backlog-manual-000087',
    attachCommand: "tmux attach -t ='backlog-manual-000087'",
  } as const;

  assert.match(
    formatBacklogRefineOutput({ ...base, launched: false } as never),
    /Prepared refinement for MANUAL-000087/,
  );
  assert.match(
    formatBacklogRefineOutput({ ...base, launched: true } as never),
    /Launched refinement for MANUAL-000087/,
  );
  assert.match(
    formatBacklogRefineOutput({
      ...base,
      launched: false,
      attachedExisting: true,
    } as never),
    /Reopened refinement for MANUAL-000087/,
  );

  assert.match(
    formatBacklogRefinementSessionOutput({
      itemId: 'b1',
      tmuxSession: 'backlog-manual-000087',
      tmuxTarget: 'backlog-manual-000087',
      exists: true,
      attachCommand: "tmux attach -t ='backlog-manual-000087'",
    }),
    /running/,
  );
  assert.match(
    formatBacklogRefinementSessionOutput({
      itemId: 'b1',
      tmuxSession: 'backlog-manual-000087',
      tmuxTarget: 'backlog-manual-000087',
      exists: false,
      attachCommand: "tmux attach -t ='backlog-manual-000087'",
    }),
    /absent/,
  );
});
