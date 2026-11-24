import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Run state under a temporary home, never the operator's.
const home = mkdtempSync(path.join(os.tmpdir(), 'failed-step-log-home-'));
process.env.FARMSLOT_HOME = home;
test.after(() => rm(home, { recursive: true, force: true }));

const { runSessionArchiveDir } = await import('../runs/store.js');
const { retainFailedStepLogs } = await import('./failed-step-log.js');

async function slotLogs(t: import('node:test').TestContext, files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prepare-logs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(dir, name), content);
  return (name: string) => path.join(dir, name);
}

test('a failed run keeps its own copy of the slot log, which the next prepare cannot overwrite', async (t) => {
  const runId = `failed-log-${process.pid}-a`;
  const at = await slotLogs(t, { 'deps.log': 'YN0028: lockfile would be modified\n' });
  const log = at('deps.log');

  const kept = await retainFailedStepLogs(
    runId,
    { failedLogPath: log },
    `yarn install failed (exit 1) — log: ${log}`,
    new Date('2026-11-24T10:00:00.000Z'),
  );

  assert.equal(
    path.dirname(kept.failedLogPath!),
    path.join(runSessionArchiveDir(runId), 'prepare-logs'),
  );
  assert.match(
    path.basename(kept.failedLogPath!),
    /^deps-2026-11-24T10-00-00-000Z-[0-9a-f]{8}\.log$/,
  );
  assert.equal(kept.message, `yarn install failed (exit 1) — log: ${kept.failedLogPath}`);
  await writeFile(log, 'the next run on this slot\n');
  assert.equal(await readFile(kept.failedLogPath!, 'utf8'), 'YN0028: lockfile would be modified\n');
});

test('each failure keeps its own copy, even within the same millisecond', async (t) => {
  const runId = `failed-log-${process.pid}-b`;
  const at = await slotLogs(t, { 'deps.log': 'first\n' });
  const now = new Date('2026-11-24T10:00:00Z');
  const first = await retainFailedStepLogs(runId, { failedLogPath: at('deps.log') }, '', now);
  await writeFile(at('deps.log'), 'second\n');
  const second = await retainFailedStepLogs(runId, { failedLogPath: at('deps.log') }, '', now);
  assert.notEqual(first.failedLogPath, second.failedLogPath);
  assert.equal(await readFile(first.failedLogPath!, 'utf8'), 'first\n');
  assert.equal(await readFile(second.failedLogPath!, 'utf8'), 'second\n');
});

test('a message without the log path still names the copy', async (t) => {
  const at = await slotLogs(t, { 'preflight.log': 'x\n' });
  const kept = await retainFailedStepLogs(
    `failed-log-${process.pid}-c`,
    { failedLogPath: at('preflight.log') },
    'preflight failed',
  );
  assert.equal(kept.message, `preflight failed — log: ${kept.failedLogPath}`);
});

test('related logs are copied only when they are on the gateway', async (t) => {
  const runId = `failed-log-${process.pid}-d`;
  const at = await slotLogs(t, { 'preflight.log': 'p\n', 'metro.log': 'metro\n' });
  const related = [at('metro.log')];
  const local = await retainFailedStepLogs(
    runId,
    { failedLogPath: at('preflight.log'), relatedLogs: related, relatedLogsOnGateway: true },
    '',
  );
  assert.equal(
    path.dirname(local.relatedLogs![0]!),
    path.join(runSessionArchiveDir(runId), 'prepare-logs'),
  );
  assert.equal(await readFile(local.relatedLogs![0]!, 'utf8'), 'metro\n');
  // A remote slot's paths name files on the slot host; a same-named gateway file is not copied.
  const remote = await retainFailedStepLogs(
    runId,
    { failedLogPath: at('preflight.log'), relatedLogs: related },
    '',
  );
  assert.deepEqual(remote.relatedLogs, related);
  assert.equal(
    (await readdir(path.join(runSessionArchiveDir(runId), 'prepare-logs'))).filter((f) =>
      f.startsWith('metro-'),
    ).length,
    1,
  );
});

test('a log that cannot be copied leaves the step naming the slot log', async (t) => {
  const runId = `failed-log-${process.pid}-e`;
  const missing = path.join(os.tmpdir(), `no-such-prepare-log-${process.pid}.log`);
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (line: string) => warnings.push(line));
  assert.deepEqual(
    await retainFailedStepLogs(runId, { failedLogPath: missing }, `log: ${missing}`),
    { failedLogPath: missing, relatedLogs: undefined, message: `log: ${missing}` },
  );
  assert.match(warnings.join('\n'), /could not keep a copy of .*no-such-prepare-log/);
  assert.deepEqual(await retainFailedStepLogs(runId, {}, 'no log'), {
    failedLogPath: undefined,
    relatedLogs: undefined,
    message: 'no log',
  });
});
