#!/usr/bin/env node
// Startup-only owning source fixtures. The prior recording is input, not proof for this case.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const caseDir = process.env.FARMSLOT_VIEW_SHARING_CASE;
const recordingRoot = process.env.FARMSLOT_VIEW_SHARING_RECORDING_SOURCE;
assert(caseDir && path.isAbsolute(caseDir));
assert(recordingRoot && path.isAbsolute(recordingRoot));
const fixture = JSON.parse(await readFile(path.join(caseDir, 'fixture.json'), 'utf8'));
assert.equal(fixture.sourceRoot, root);
const live = await readdir(path.join(fixture.home, 'gateways.live')).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
assert.equal(live.length, 0, 'Prepare the source fixture before Gateway startup');
const put = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await put(path.join(caseDir, 'identity-fixture-started.json'), { sourceRoot: root, caseDir });
const summary = JSON.parse(await readFile(path.join(recordingRoot, 'summary.json'), 'utf8'));
const claims = JSON.parse(
  await readFile(path.join(recordingRoot, 'acceptance-status.json'), 'utf8'),
);
assert.equal(summary.status, 'pass');
assert.equal(claims.recording.status, 'complete');
for (const segment of claims.recording.segments)
  assert.equal(
    'sha256:' + hash(await readFile(path.join(recordingRoot, segment.videoPath))),
    segment.videoDigest,
  );
Object.assign(process.env, {
  FARMSLOT_HOME: fixture.home,
  FARMSLOT_ROOT: fixture.controlRoot,
  FARMSLOT_RUNS_DIR: fixture.runsDir,
  FARMSLOT_STATUS_FILE: path.join(fixture.controlRoot, '.farm-status.json'),
  FARMSLOT_POOL_DIR: path.join(fixture.controlRoot, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(fixture.controlRoot, 'projects'),
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
});
const { loadAllRuns, getRun, updateRun, persistRunNow } = await import(
  path.join(root, 'services/gateway/src/runs/store.ts')
);
const { claimSlotStatusIf } = await import(path.join(root, 'services/gateway/src/core/state.ts'));
const { createRunArtifactAcquisition, retainCapturedRunArtifacts } = await import(
  path.join(root, 'services/gateway/src/run-completion/retained-artifacts.ts')
);
await loadAllRuns();
const [retained, current] = fixture.runs;
const poolFile = path.join(fixture.controlRoot, 'pool', fixture.machine + '.json');
const poolBytes = await readFile(poolFile);
await writeFile(path.join(caseDir, 'identity-pool.prestate.json'), poolBytes, {
  flag: 'wx',
  mode: 0o600,
});
const before = [];
for (const run of fixture.runs) {
  const bytes = await readFile(path.join(fixture.runsDir, run.id + '.json'));
  await writeFile(path.join(caseDir, run.id + '.identity-prestate.json'), bytes, {
    flag: 'wx',
    mode: 0o600,
  });
  before.push({ id: run.id, sha256: hash(bytes) });
}
const slotId = 'view-sharing-history-slot';
const repo = path.join(fixture.controlRoot, 'slot-repo');
await mkdir(repo, { mode: 0o700 });
const gitEnvironment = { ...process.env };
for (const key of Object.keys(gitEnvironment))
  if (key.startsWith('GIT_')) delete gitEnvironment[key];
execFileSync('git', ['init', '--quiet', '--initial-branch=view-sharing-source', repo], {
  cwd: repo,
  env: gitEnvironment,
});
const pool = JSON.parse(poolBytes);
assert.deepEqual(pool.slots, []);
pool.slots = [{ id: slotId, enabled: true, mode: 'dispatch', repo, resources: {} }];
await writeFile(poolFile, JSON.stringify(pool, null, 2) + '\n', { mode: 0o600 });
const taskDir = path.join(fixture.controlRoot, 'tasks', retained.id);
const prefix = 'artifacts/';
await mkdir(path.join(taskDir, prefix), { recursive: true, mode: 0o700 });
const taskFile = path.join(taskDir, 'task.md');
await writeFile(
  taskFile,
  '# Retained sharing identity fixture\n\nRead-only navigation of historical run A while its slot holds run B.\n',
  { flag: 'wx', mode: 0o600 },
);
const manifest = [];
async function retainDirectory(relative = '') {
  for (const entry of await readdir(path.join(recordingRoot, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      await mkdir(path.join(taskDir, prefix, name), { mode: 0o700 });
      await retainDirectory(name);
    } else {
      assert(entry.isFile(), 'Only regular recorded input files are accepted');
      const source = path.join(recordingRoot, name);
      const destination = path.join(taskDir, prefix, name);
      await copyFile(source, destination);
      const bytes = await readFile(source);
      assert.equal(hash(await readFile(destination)), hash(bytes));
      manifest.push({
        path: prefix + name,
        purpose: 'evidence',
        sha256: hash(bytes),
        sizeBytes: bytes.length,
      });
    }
  }
}
await retainDirectory();
const capturedAt = new Date().toISOString();
const manifestDigest = hash(JSON.stringify(manifest));
updateRun(retained.id, {
  slotId,
  taskFile,
  summary: 'Retained run A for exact sharing',
  ticketOrPr: 'Retained run A for exact sharing',
  recordedEvidenceContractVersion: 1,
  output: {
    capturedAt,
    workerFinished: true,
    artifactManifest: manifest,
    manifestDigest,
    reportPath: prefix + 'summary.json',
  },
});
await persistRunNow(getRun(retained.id), 'historical sharing source fixture');
updateRun(current.id, { slotId, summary: 'Current slot run B', ticketOrPr: 'Current slot run B' });
await persistRunNow(getRun(current.id), 'current slot source fixture');
await put(path.join(fixture.controlRoot, '.farm-status.json'), {
  checked_at: capturedAt,
  slots: [],
});
const claim = await claimSlotStatusIf(slotId, (slot) => !slot.current_run_id, {
  machine: fixture.machine,
  project: fixture.project,
  platform: 'web',
  repo,
  enabled: true,
  lifecycle: 'busy',
  phase: null,
  held_reason: 'Retained source owner B',
  current_run_id: current.id,
  current_flow_type: 'dev',
  current_ticket_or_pr: 'Current slot run B',
});
assert.equal(claim.claimed, true);
const retainedResult = await retainCapturedRunArtifacts({
  run: getRun(retained.id),
  artifacts: manifest,
  manifestDigest,
  acquireMedia: createRunArtifactAcquisition(getRun(retained.id)).acquireMedia,
  commit: async (ref, missingData) => {
    updateRun(retained.id, {
      artifactBundle: ref,
      output: {
        ...getRun(retained.id).output,
        artifactBundle: ref,
        retentionMissingData: missingData,
      },
    });
    await persistRunNow(getRun(retained.id), 'retain measured recording fixture');
  },
});
assert.deepEqual(retainedResult.missingData, []);
const after = [];
for (const run of fixture.runs)
  after.push({
    id: run.id,
    sha256: hash(await readFile(path.join(fixture.runsDir, run.id + '.json'))),
  });
await put(path.join(caseDir, 'identity-fixture.json'), {
  sourceRoot: root,
  caseDir,
  slotId,
  retainedRunId: retained.id,
  currentRunId: current.id,
  noReviewWorkspace: !getRun(retained.id).reviewWorkspace,
  before,
  after,
  claim,
  poolBeforeSha256: hash(poolBytes),
  poolAfterSha256: hash(await readFile(poolFile)),
  recordingSummarySha256: hash(await readFile(path.join(recordingRoot, 'summary.json'))),
  recordingInputFiles: manifest,
  recordedRecipeRunId: claims.recipeRunId,
  video: prefix + claims.recording.segments[0].videoPath,
  sourceWriters: ['run store', 'claimSlotStatusIf', 'retainCapturedRunArtifacts'],
  currentCaseAcceptanceFromPriorRecording: false,
});
console.log(
  JSON.stringify({
    status: 'PASS',
    fixture: 'historical-slot-and-recording',
    credentialsPrinted: false,
  }),
);
