import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { type ChatMessage, Events } from '@farmslot/protocol';
import type { ResourceKey } from '@farmslot/protocol/client-cache';

import { resourceRevisions } from '../resources/revisions.js';

const home = await mkdtemp(path.join(os.tmpdir(), 'copilot-memory-publication-'));
const originalHome = process.env.FARMSLOT_COPILOT_DIR;
process.env.FARMSLOT_COPILOT_DIR = home;
const memoryFile = path.join(home, 'MEMORY.md');
const memoryDirectory = path.join(home, 'memory');
const key = { family: 'copilot', ownerId: 'gateway-copilot' } as const;
const watchers = new Set<fs.FSWatcher>();
const watch = fs.watch;
mock.method(fs, 'watch', (...args: Parameters<typeof fs.watch>) => {
  const watcher = Reflect.apply(watch, fs, args) as fs.FSWatcher;
  watchers.add(watcher);
  watcher.once('close', () => watchers.delete(watcher));
  return watcher;
});
syncBuiltinESMExports();
// Only the external model and unused fleet-root dependency are replaced. File writes and
// watchers, cache invalidation and the production resource revision owner remain real.
mock.module('../fleet/state.js', { namedExports: { farmslotRoot: home } });
mock.module('../llm/index.js', {
  namedExports: { callLLM: async () => ({ text: 'saved-source-summary' }) },
});
const memory = await import('./chat-memory.js');
await memory.ensureCopilotDirs();

test.afterEach(async () => {
  await Promise.all(
    [...watchers].map(
      (watcher) =>
        new Promise<void>((resolve) => {
          watcher.once('close', resolve);
          watcher.close();
        }),
    ),
  );
});
test.after(async () => {
  mock.restoreAll();
  syncBuiltinESMExports();
  if (originalHome === undefined) delete process.env.FARMSLOT_COPILOT_DIR;
  else process.env.FARMSLOT_COPILOT_DIR = originalHome;
  await rm(home, { recursive: true, force: true });
});

async function changedAfter(before: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (resourceRevisions.revision(key) <= before && Date.now() < deadline) await delay(10);
  assert(resourceRevisions.revision(key) > before, 'Actual saved-memory changes publish a key');
}

function captureKeys(t: test.TestContext, readable?: () => void): ResourceKey[] {
  const keys: ResourceKey[] = [];
  const advance = resourceRevisions.advance.bind(resourceRevisions);
  t.mock.method(
    resourceRevisions,
    'advance',
    (...args: Parameters<typeof resourceRevisions.advance>) => {
      readable?.();
      keys.push(structuredClone(args[0]));
      advance(...args);
    },
  );
  return keys;
}

test('an existing bootstrap-memory source change invalidates its read cache and shared key', async (t) => {
  const keys = captureKeys(t);
  assert((await memory.loadMemory()).includes('Farmslot Co-Pilot Memory'));
  const before = resourceRevisions.revision(key);
  await writeFile(memoryFile, 'External saved memory', 'utf8');
  await changedAfter(before);
  assert.equal(await memory.loadMemory(), 'External saved memory');
  assert(keys.length > 0);
  assert(keys.every((actual) => JSON.stringify(actual) === JSON.stringify(key)));
});

test('the owning memory writer publishes only after its new bytes are readable', async (t) => {
  const keys = captureKeys(t, () =>
    assert.equal(fs.readFileSync(memoryFile, 'utf8'), 'Owned saved memory'),
  );
  const before = resourceRevisions.revision(key);
  await memory.saveMemory('Owned saved memory');
  assert(resourceRevisions.revision(key) > before);
  assert.equal(await readFile(memoryFile, 'utf8'), 'Owned saved memory');
  assert.equal(await memory.loadMemory(), 'Owned saved memory');
  assert.deepEqual(keys, [key]);
});

test('a failed owning memory write cannot publish a successful revision', async () => {
  await rm(memoryFile);
  await mkdir(memoryFile);
  const before = resourceRevisions.revision(key);
  await assert.rejects(memory.saveMemory('Uncommitted'), { code: 'EISDIR' });
  assert.equal(resourceRevisions.revision(key), before);
  await rm(memoryFile, { recursive: true });
});

const messages: ChatMessage[] = [
  {
    id: 'private-message',
    role: 'user',
    content: 'A fixture conversation',
    timestamp: new Date().toISOString(),
  },
];

test('session-summary persistence publishes readable bytes without private paths in the key', async (t) => {
  const keys = captureKeys(t, () => {
    const files = fs.readdirSync(memoryDirectory);
    assert.equal(files.length, 1);
    const published = fs.readFileSync(path.join(memoryDirectory, files[0]!), 'utf8');
    assert(published.includes('private-session') && published.includes('saved-source-summary'));
  });
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const before = resourceRevisions.revision(key);
  const file = await memory.saveSessionMemory('private-session', messages, (event, payload) => {
    broadcasts.push({ event, payload });
  });
  assert(file && file.startsWith(memoryDirectory + path.sep));
  const text = await readFile(file, 'utf8');
  assert(text.includes('private-session') && text.includes('saved-source-summary'));
  assert(resourceRevisions.revision(key) > before);
  assert.deepEqual(keys, [key]);
  assert.equal(broadcasts[0]?.event, Events.CHAT_MEMORY_SAVED);
  assert(!JSON.stringify(keys).includes(home));
  assert(!JSON.stringify(keys).includes('private-session'));
});

test('empty summaries and failed summary writes remain publication-quiet', async () => {
  const before = resourceRevisions.revision(key);
  assert.equal(
    await memory.saveSessionMemory('empty', [], () => assert.fail('No empty summary event')),
    undefined,
  );
  await rm(memoryDirectory, { recursive: true });
  await writeFile(memoryDirectory, 'Not a directory', 'utf8');
  await assert.rejects(
    memory.saveSessionMemory('failed', messages, () => assert.fail('No failed summary event')),
    { code: 'ENOTDIR' },
  );
  assert.equal(resourceRevisions.revision(key), before);
});
