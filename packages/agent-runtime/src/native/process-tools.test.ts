import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeToolDiffText } from '@farmslot/protocol/client-cache';

import { projectProcessHistory } from './process-history.js';
import {
  markerChangeSignature,
  type ProcessToolObservation,
  type ProcessToolScope,
  projectProcessTools,
} from './process-tools.js';

const at = '2026-11-08T00:00:10.000Z';
const scope: ProcessToolScope = {
  repo: '/repo',
  taskDir: '/repo/.task/current',
  productPaths: ['src/value.ts'],
  markerSignatures: [],
};

function command(value: string, id = 'tool'): ProcessToolObservation[] {
  return [
    {
      id,
      at,
      phase: 'request',
      tool: { name: 'shell', kind: 'command', command: value },
      ref: { sourceId: 'history', line: 1, toolId: id },
    },
    {
      id,
      at,
      phase: 'result',
      status: 'succeeded',
      ref: { sourceId: 'history', line: 2, toolId: id },
    },
  ];
}

test('repeated deterministic marks retain targets and separate compound-command positions', () => {
  const events = command(
    'cd /repo/.task/current && ./mark 14 && ./mark --checklist CHECKLIST.md 14',
  );
  const result = projectProcessTools(events, scope);
  assert.equal(result.marks.length, 2);
  assert.deepEqual(
    result.marks.map((mark) => mark.target),
    [
      { action: 'step', stepNumber: 14 },
      { action: 'step', stepNumber: 14 },
    ],
  );
  assert.deepEqual(
    result.marks.map((mark) => mark.commandIndex),
    [1, 2],
  );
  assert.ok(result.marks.every((mark) => mark.status === 'unknown'));
});

test('only a direct task-owned mark inherits its correlated result', () => {
  const direct = projectProcessTools(
    command('/repo/.task/current/mark complete --mark-last'),
    scope,
  );
  assert.equal(direct.marks[0].status, 'succeeded');
  assert.deepEqual(direct.marks[0].target, { action: 'complete' });
  const cli = projectProcessTools(
    command('farmslot-agent mark /repo/.task/current --checklist REVIEW.md complete'),
    scope,
  );
  assert.equal(cli.marks[0].checklist, 'REVIEW.md');
  assert.deepEqual(cli.marks[0].target, { action: 'complete' });
  assert.equal(projectProcessTools(command('cat /repo/.task/current/mark'), scope).marks.length, 0);
  assert.equal(projectProcessTools(command('/repo/.task/foreign/mark 14'), scope).marks.length, 0);
  assert.equal(
    projectProcessTools(command('echo "/repo/.task/current/mark 14"'), scope).marks.length,
    0,
  );
});

test('literal task aliases in real worker commands retain marks without claiming compound success', () => {
  const result = projectProcessTools(
    command('cd /repo; T=.task/current; $T/mark 1; ${T}/mark 12'),
    scope,
  );
  assert.deepEqual(
    result.marks.map((mark) => mark.target),
    [
      { action: 'step', stepNumber: 1 },
      { action: 'step', stepNumber: 12 },
    ],
  );
  assert.ok(result.marks.every((mark) => mark.status === 'unknown'));
  assert.equal(projectProcessTools(command("T=.task/current; '$T/mark' 1"), scope).marks.length, 0);
  assert.equal(projectProcessTools(command('T=$(pwd); $T/mark 1'), scope).marks.length, 0);
  assert.equal(
    projectProcessTools(command("cat <<'EOF'\n/repo/.task/current/mark 1\nEOF"), scope).marks
      .length,
    0,
  );
});

test('a preverified marker signature excludes only its exact edit, not ordinary logging', () => {
  const before = 'const value = state;\n';
  const after = before + "DevLogger.log('[example] BUG_MARKER: state');\n";
  const signature = markerChangeSignature(
    nativeToolDiffText({ path: 'src/value.ts', oldText: before, newText: after }),
  );
  assert.ok(signature);
  const events: ProcessToolObservation[] = [
    {
      id: 'edit',
      at,
      phase: 'request',
      tool: {
        name: 'Edit',
        kind: 'file-edit',
        paths: ['/repo/src/value.ts'],
        input: { old_string: before, new_string: after },
      },
      ref: { sourceId: 'history', line: 1 },
    },
    { id: 'edit', at, phase: 'result', status: 'succeeded', ref: { sourceId: 'history', line: 2 } },
  ];
  assert.equal(
    projectProcessTools(events, { ...scope, markerSignatures: [signature] }).edits[0]
      .classification,
    'diagnostic-marker',
  );
  assert.equal(projectProcessTools(events, scope).edits[0].classification, 'unknown');
});

test('duplicate structured Claude calls collapse while a failed result never becomes an observed edit', () => {
  const request = {
    type: 'assistant',
    timestamp: at,
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'edit',
          name: 'Edit',
          input: { file_path: '/repo/src/value.ts', old_string: 'old', new_string: 'fixed' },
        },
      ],
    },
  };
  const response = {
    type: 'user',
    timestamp: at,
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'edit', is_error: true, content: 'not applied' },
      ],
    },
  };
  const projected = projectProcessHistory(
    'claude-jsonl',
    [request, request, response].map((row) => JSON.stringify(row)),
    'history',
    0,
    Date.parse(at),
  );
  const result = projectProcessTools(projected.events, scope);
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0].status, 'failed');
  assert.equal(result.edits[0].classification, 'product');
});

test('Pi JSONL correlation ignores prose and events outside the provider-clock window', () => {
  const rows = [
    {
      type: 'message',
      timestamp: at,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I ran mark 14 successfully' },
          {
            type: 'toolCall',
            id: 'mark',
            name: 'bash',
            arguments: { command: '/repo/.task/current/mark 14' },
          },
        ],
      },
    },
    {
      type: 'message',
      timestamp: at,
      message: { role: 'toolResult', toolCallId: 'mark', isError: false, content: [] },
    },
  ].map((row) => JSON.stringify(row));
  const projected = projectProcessHistory('pi-jsonl', rows, 'history', 0, Date.parse(at));
  assert.equal(projectProcessTools(projected.events, scope).marks[0].status, 'succeeded');
  assert.equal(
    projectProcessHistory('pi-jsonl', rows, 'history', Date.parse(at) + 1, Date.parse(at) + 100)
      .events.length,
    0,
  );
});
