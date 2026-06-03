// chat-action-normalization.test.ts — Co-Pilot action payload normalization checks
// Usage: tsx services/gateway/src/chat/chat-action-normalization.test.ts

import { mkdtempSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ChatSuggestedAction } from '@farmslot/protocol';

const testRoot = mkdtempSync(path.join(tmpdir(), 'farmslot-chat-action-normalization-test-'));
process.env.FARMSLOT_COPILOT_DIR = path.join(testRoot, 'copilot');
process.env.FARMSLOT_RUNS_DIR = path.join(testRoot, 'runs');
await mkdir(process.env.FARMSLOT_COPILOT_DIR, { recursive: true });
await mkdir(process.env.FARMSLOT_RUNS_DIR, { recursive: true });

const { normalizeActionParams } = await import('./chat-action-normalization.js');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`${GREEN}PASS${RESET} ${name}`);
    passed++;
  } catch (err) {
    console.log(`${RED}FAIL${RESET} ${name}: ${(err as Error).message}`);
    failed++;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

await test('normalizes write-capable gateway actions into server-owned payloads', () => {
  const actions: ChatSuggestedAction[] = [
    {
      type: 'run.create',
      label: 'Dispatch fix',
      params: {
        flowType: 'fix-bug',
        project: 'example-mobile-farm',
        ticketOrPr: 'PROJ-123',
        runner: 'claude',
        model: 'opus',
        ignored: 'not stored',
      },
    },
    {
      type: 'run.cancel',
      label: 'Cancel run',
      params: { runId: 'run-cancel', reason: 'Confirmed by Co-Pilot', ignored: 'not stored' },
    },
    { type: 'run.delete', label: 'Remove failed run', params: { runId: 'run-delete' } },
    {
      type: 'terminal.send',
      label: 'Nudge worker',
      params: { slotId: 'mini-mm-1', text: 'Please report status.', enter: true, ignored: true },
    },
    {
      type: 'decision.resolve',
      label: 'Accept decision',
      params: { decisionId: 'd1', choice: 'accept' },
    },
    { type: 'memory.update', label: 'Save memory', params: { content: 'memory' } },
  ];

  const normalized = actions.map((action) => normalizeActionParams(action));
  assert(
    normalized.map((action) => action?.type).join(',') ===
      'run.create,run.cancel,run.delete,terminal.send,decision.resolve,memory.update',
    `unexpected action types: ${normalized.map((action) => action?.type).join(',')}`,
  );
  assert(!('ignored' in normalized[0]!.params), 'run.create retained unallowlisted params');
  assert(!('ignored' in normalized[3]!.params), 'terminal.send retained unallowlisted params');
  assert(normalized[4]!.params.actionId === 'accept', 'decision choice alias was not normalized');
});

await test('slot.prepare keeps only slotId even when model supplies checkout params', () => {
  const normalized = normalizeActionParams({
    type: 'slot.prepare',
    label: 'Prepare slot',
    params: { slotId: 'mini-mm-1', branch: 'feat/x', mergeMain: true },
  });
  assert(normalized?.type === 'slot.prepare', `unexpected type ${normalized?.type}`);
  assert(
    normalized.params.slotId === 'mini-mm-1',
    `slotId not preserved: ${normalized.params.slotId}`,
  );
  assert(!('branch' in normalized.params), 'slot.prepare must not echo branch');
  assert(!('mergeMain' in normalized.params), 'slot.prepare must not echo mergeMain');
  assert(
    Object.keys(normalized.params).length === 1,
    `slot.prepare params should only contain slotId, got: ${Object.keys(normalized.params).join(',')}`,
  );
});

await test('rejects unknown action types and invalid action shapes', () => {
  assert(
    normalizeActionParams({
      type: 'unknown.type',
      label: 'Unknown',
      params: {},
    } as unknown as ChatSuggestedAction) === null,
    'unknown action should be rejected',
  );
  assert(
    normalizeActionParams({ type: 'memory.update', label: '   ', params: { content: 'x' } }) ===
      null,
    'blank label should be rejected',
  );
  assert(
    normalizeActionParams({ type: 'memory.update', label: 'Save', params: { content: '' } }) ===
      null,
    'blank content should be rejected',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
