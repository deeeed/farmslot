import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { WorkerSessionHistorySnapshot } from '@farmslot/protocol';

import { LegacySessionAppends } from './legacy-session-appends.js';

test(
  'two readers share one append source and receive only complete utf8 records without reloading history',
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-appends-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'session.jsonl');
    await writeFile(path, '');
    const file = await stat(path);
    const initial: WorkerSessionHistorySnapshot = {
      slotId: 'fixture',
      runId: 'run',
      runner: 'codex',
      source: 'transcript',
      runnerSessionId: 'conversation',
      runnerSessionPath: path,
      messages: [],
      generatedAt: 'now',
      cursor: { fileIdentity: `${file.dev}:${file.ino}`, path, offset: 0, messageCount: 0 },
    };
    const source = new LegacySessionAppends();
    let loads = 0;
    const load = async () => {
      loads++;
      return initial;
    };
    let first!: (value: WorkerSessionHistorySnapshot) => void;
    let second!: (value: WorkerSessionHistorySnapshot) => void;
    let refuse!: (error: Error) => void;
    const failed = new Promise<never>((_resolve, reject) => {
      refuse = reject;
    });
    const a = new Promise<WorkerSessionHistorySnapshot>((resolve) => {
      first = resolve;
    });
    const b = new Promise<WorkerSessionHistorySnapshot>((resolve) => {
      second = resolve;
    });
    const left = await source.observe('source', path, undefined, load, {
      changed: first,
      failed: refuse,
    });
    const right = await source.observe('source', path, undefined, load, {
      changed: second,
      failed: refuse,
    });
    t.after(() => {
      left.stop();
      right.stop();
    });
    const template = {
      id: 'message',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'PLACEHOLDER' }],
      },
    };
    const prefix = JSON.stringify(template).indexOf('PLACEHOLDER');
    const text = 'x'.repeat(128 * 1024 - 2 - prefix) + '😀done';
    template.payload.content[0].text = text;
    const record = JSON.stringify(template) + '\n';
    await appendFile(path, record);
    const snapshots = await Promise.race([Promise.all([a, b]), failed]);
    for (const snapshot of snapshots) {
      assert.equal(snapshot.messages.length, 1);
      assert.equal(snapshot.messages[0].text, text);
      assert.equal(snapshot.cursor?.offset, Buffer.byteLength(record));
    }
    assert.equal(loads, 1, 'Appending must not repeat initial history reads');
    left.stop();
    right.stop();
  },
);
