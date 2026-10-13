import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

await import('../runtime/mock-pty.test-support.js');
const { buildRunRecord, getRun, loadAllRuns, runsDirectory } = await import('./store.js');

test('the gateway stamps new runs and ignores a caller-supplied evidence contract', () => {
  const params = {
    flowType: 'dev',
    project: 'fixture',
    ticketOrPr: 'TEST-EVIDENCE',
    recordedEvidenceContractVersion: 0,
  } as const;
  const run = buildRunRecord(params);
  assert.equal(run.recordedEvidenceContractVersion, 1);
  assert.equal(params.recordedEvidenceContractVersion, 0);
});

test('loading a historical run does not stamp an evidence contract version', async (t) => {
  const historical = buildRunRecord({
    flowType: 'dev',
    project: 'fixture',
    ticketOrPr: 'RETAINED-EVIDENCE',
  });
  historical.status = 'done';
  delete historical.recordedEvidenceContractVersion;
  const filename = path.join(runsDirectory(), `${historical.id}.json`);
  await mkdir(runsDirectory(), { recursive: true });
  t.after(() => rm(filename, { force: true }));
  await writeFile(filename, JSON.stringify(historical));
  await loadAllRuns();
  const loaded = getRun(historical.id);
  assert(loaded);
  assert.equal(loaded.recordedEvidenceContractVersion, undefined);
});
