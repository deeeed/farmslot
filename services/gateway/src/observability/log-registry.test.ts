import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findRegisteredLogEntry, listLogRegistryEntries } from './log-registry.js';

test('runtime log fallback stays inside its canonical log tree', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-runtime-logs-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'farmslot-runtime-outside-'));
  t.after(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  const nestedDir = path.join(root, 'prepare-mini-core-1');
  const logPath = path.join(nestedDir, 'preflight.log');
  await mkdir(nestedDir, { recursive: true });
  await writeFile(logPath, 'prepare failed\n');
  const accepted = await findRegisteredLogEntry(logPath, [], root);
  assert.equal(accepted?.path, await realpath(logPath));
  assert.equal(accepted?.category, 'prepare');

  const outsideLog = path.join(outside, 'secret.log');
  await writeFile(outsideLog, 'secret\n');
  const leafLink = path.join(root, 'leaf.log');
  const dirLink = path.join(root, 'linked-dir');
  await symlink(outsideLog, leafLink);
  await symlink(outside, dirLink);
  assert.equal(await findRegisteredLogEntry(leafLink, [], root), null);
  assert.equal(await findRegisteredLogEntry(path.join(dirLink, 'secret.log'), [], root), null);

  const nonLog = path.join(root, 'notes.md');
  await writeFile(nonLog, 'not a log\n');
  assert.equal(await findRegisteredLogEntry(nonLog, [], root), null);
  assert.equal(await findRegisteredLogEntry('prepare-mini-core-1/preflight.log', [], root), null);
  assert.equal(await findRegisteredLogEntry(logPath, [], path.join(root, 'missing')), null);
});

test('log registry scans intelligence-audit ndjson files', async (t) => {
  const prev = process.env.HOME;
  const home = mkdtempSync(path.join(tmpdir(), 'farmslot-log-home-'));
  process.env.HOME = home;
  t.after(async () => {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    await rm(home, { recursive: true, force: true });
  });
  const dir = path.join(home, '.farmslot', 'logs', 'intelligence-actions');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '2026-05-12.ndjson'), '{}\n');
  const entries = await listLogRegistryEntries();
  const entry = entries.find((e) => e.category === 'intelligence-audit');
  assert.ok(entry);
  assert.equal(entry?.displayPath, '<intelligence-audit>/2026-05-12.ndjson');
});
test('log registry honors intelligence audit directory override', async (t) => {
  const prev = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-log-audit-override-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = dir;
  t.after(async () => {
    if (prev === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, '2026-05-12.ndjson');
  await writeFile(file, '{}\n');
  const entries = await listLogRegistryEntries();
  const entry = entries.find(
    (e) =>
      e.category === 'intelligence-audit' &&
      e.displayPath === '<intelligence-audit>/2026-05-12.ndjson',
  );
  assert.ok(entry);
  assert.equal(entry?.path, await realpath(file));
});
