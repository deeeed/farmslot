import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listLogRegistryEntries } from './log-registry.js';
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
