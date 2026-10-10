// The harness-owned framed recorder: capture-helper records the browser a
// platform names (`recording.framed`) for the whole run, actions take in-session
// snapshots while it runs, and the video is published into the run's artifacts.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  type CaptureHelperInterruptionEvent,
  captureHelperStreamStopped,
  keptCaptureInterruption,
  optionalVideoTiming,
  parseCaptureHelperInterruption,
  readCaptureHelperTiming,
  type RecipeRunCaptureInterruption,
  type RecipeRunResult,
  recordCaptureInterruptionInPackage,
  runCaptureInterruption,
  writeRecordingTimeline,
} from '@farmslot/recipe-runner';

import { harnessAdapter } from './adapters.js';
import { harnessHost } from './host.js';
import {
  captureHelperPath,
  captureHelperSupportsCapability,
  captureHelperSupportsRecordSessionSnapshots,
} from './recording-target.js';

export interface RecipeRecordingOptions {
  record?: boolean;
  cdpPort?: string;
}

export interface ActiveRecipeRecording {
  child: ChildProcessWithoutNullStreams;
  outputPath: string;
  stagingDir: string;
  stagedPath: string;
  relativePath: string;
  pid: number;
  stdout: string;
  stderr: string;
  exited: boolean;
  exitCode: number | null;
  frameReady: boolean;
  streamStopped?: boolean;
  finalized: boolean;
  finalizationError?: unknown;
  startedAtUnixMs: number;
  stoppedAtUnixMs?: number;
  nativeTiming: boolean;
  completedRecordingId?: string;
  completedVideo?: boolean;
  /** capture-helper's `stream_interrupted` event: its stream stopped and it kept the frames so far. */
  interruption?: CaptureHelperInterruptionEvent;
  nativeTimingEvidence?: Awaited<ReturnType<typeof readCaptureHelperTiming>>;
  error?: Error;
  // The environment variable that names the recorded pid to actions.
  activePidEnv: string;
  previousActiveRecordingPid: string | undefined;
  stderrBuffer: string;
  pendingSnapshots: Map<string, PendingRecordingSnapshot>;
}

interface PendingRecordingSnapshot {
  outputPath: string;
  timer: NodeJS.Timeout;
  // undefined: no in-session frame (the stream stopped), so the caller captures without it.
  resolve: (event: Record<string, unknown> | undefined) => void;
  reject: (error: Error) => void;
}

const activeRecordingsByPid = new Map<number, ActiveRecipeRecording>();

export async function startRecipeRecording(
  adapter: string,
  projectRoot: string,
  artifactsDir: string,
  options: RecipeRecordingOptions,
): Promise<ActiveRecipeRecording | undefined> {
  if (!options.record) return undefined;
  if (process.platform !== 'darwin') {
    console.error(
      'WARN: --record-video uses capture-helper and is currently supported only on macOS; continuing without video.',
    );
    return undefined;
  }

  const framed = harnessAdapter(adapter).recording?.framed;
  if (!framed) return undefined;

  const cdpPort = options.cdpPort ?? process.env.CDP_PORT ?? process.env.RECIPE_CDP_PORT;
  if (!captureHelperSupportsRecordSessionSnapshots(projectRoot)) {
    console.error(
      `WARN: framed ${adapter} recording requires capture-helper capability record_session_snapshot; falling back to harness --record-video.`,
    );
    return undefined;
  }
  const pid = framed.browserPid(projectRoot, artifactsDir, cdpPort);
  if (!pid) {
    console.error(
      `WARN: framed ${adapter} recording could not resolve browser PID from CDP port ${cdpPort ?? '<unset>'}; falling back to harness --record-video.`,
    );
    return undefined;
  }
  const recordArgs = ['record', '--framed', '--pid', String(pid)];

  const relativePath = 'videos/full-run.mp4';
  const outputPath = path.join(artifactsDir, relativePath);
  const { stagingDir, stagedPath } = preparePrivateRecordingDestination(artifactsDir, outputPath);
  let child: ChildProcessWithoutNullStreams;
  const startedAtUnixMs = Date.now();
  try {
    child = spawn(captureHelperPath(), [...recordArgs, '--output', stagedPath], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    cleanupRecordingStaging(stagingDir);
    throw error;
  }
  const recording: ActiveRecipeRecording = {
    child,
    startedAtUnixMs,
    nativeTiming: captureHelperSupportsCapability(projectRoot, 'record_session_timing_v1'),
    outputPath,
    stagingDir,
    stagedPath,
    relativePath,
    pid,
    stdout: '',
    stderr: '',
    exited: false,
    exitCode: null,
    frameReady: false,
    finalized: false,
    activePidEnv: framed.activePidEnv,
    previousActiveRecordingPid: process.env[framed.activePidEnv],
    stderrBuffer: '',
    pendingSnapshots: new Map(),
  };
  child.stdout.on('data', (chunk) => {
    recording.stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    recording.stderr += String(chunk);
    handleRecordingStderr(recording, String(chunk));
  });
  child.on('error', (error) => {
    recording.error = error;
    recording.stderr += error.message;
    recording.exited = true;
  });
  child.on('close', (exitCode) => {
    recording.stoppedAtUnixMs = Date.now();
    recording.exited = true;
    recording.exitCode = exitCode;
    activeRecordingsByPid.delete(recording.pid);
    restoreActiveRecordingEnvironment(recording);
    if (recording.streamStopped || keptCaptureInterruption(exitCode, recording.interruption)) {
      // Snapshots the stream stopped under fall back like any after the recording ended.
      for (const pending of recording.pendingSnapshots.values()) {
        clearTimeout(pending.timer);
        pending.resolve(undefined);
      }
      recording.pendingSnapshots.clear();
    } else
      rejectPendingSnapshots(
        recording,
        new Error(
          `capture-helper recording exited before snapshot completed (code=${exitCode ?? 'unknown'})`,
        ),
      );
  });

  await waitForRecordingReady(recording, 15_000);
  if (recording.exited) {
    cleanupRecordingStaging(recording.stagingDir);
    throw new Error(
      `capture-helper exited before recording its first frame (code=${recording.exitCode ?? 'unknown'}): ${recording.stderr || recording.stdout}`,
    );
  }
  if (!recording.frameReady) {
    try {
      await stopRecordingProcess(recording);
    } finally {
      cleanupRecordingStaging(recording.stagingDir);
    }
    throw new Error(
      `capture-helper did not record a frame within 15000ms: ${recording.stderr || recording.stdout || 'no recorder output'}`,
    );
  }
  activeRecordingsByPid.set(pid, recording);
  process.env[framed.activePidEnv] = String(pid);
  console.error(`INFO: recording recipe video with capture-helper pid=${pid} output=${outputPath}`);
  return recording;
}

/** Ask the recording of `pid` for an in-session snapshot; undefined when none runs. */
export async function captureActiveRecipeRecordingSnapshot(
  pid: number,
  outputPath: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown> | undefined> {
  const recording = activeRecordingsByPid.get(pid);
  if (!recording || recording.exited) return undefined;
  if (recording.streamStopped || recording.finalized) {
    // Wait until no session command can overwrite the fresh standalone image.
    await waitForRecordingExit(recording, timeoutMs);
    if (!recording.exited) throw new Error('Stopped recording did not finish before the snapshot.');
    return undefined;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.rmSync(outputPath, { force: true });
  return new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      recording.pendingSnapshots.delete(outputPath);
      reject(
        new Error(
          `capture-helper record session snapshot timed out after ${timeoutMs}ms: ${outputPath}`,
        ),
      );
    }, timeoutMs);
    recording.pendingSnapshots.set(outputPath, { outputPath, timer, resolve, reject });
    recording.child.stdin.write(`snapshot ${outputPath}\n`, (error) => {
      if (!error) return;
      clearTimeout(timer);
      recording.pendingSnapshots.delete(outputPath);
      reject(error);
    });
  });
}

/** Finalize and publish the run video; returns the interruption when only a partial video was kept. */
export async function stopRecipeRecording(
  recording: ActiveRecipeRecording | undefined,
  result?: RecipeRunResult,
): Promise<RecipeRunCaptureInterruption | undefined> {
  if (!recording) return undefined;
  if (recording.finalized) {
    if (recording.finalizationError !== undefined) throw recording.finalizationError;
    // The runner already stopped this recording before publishing its completion HUD.
    // Its final trace is now available for the artifact's timeline.
    if (result) await addRecordingArtifactToManifest(result, recording);
    return undefined;
  }
  recording.finalized = true;
  try {
    await stopRecordingProcess(recording);
    const validation = await validateRecordingArtifact(recording);
    if (validation.ok === false) {
      throw new Error(
        `capture-helper recording did not produce a usable video artifact: ${validation.reason}`,
      );
    }
    publishRecordingArtifact(recording);
    const kept = keptInterruption(recording);
    const interruption = kept ? runCaptureInterruption(kept, recording.relativePath) : undefined;
    // Before the manifest entry: its timeline is bound to the final trace.
    if (result && interruption)
      await recordCaptureInterruptionInPackage(
        result,
        interruption,
        new Date(recording.startedAtUnixMs),
      );
    if (result) await addRecordingArtifactToManifest(result, recording);
    return interruption;
  } catch (error) {
    recording.finalizationError = error;
    if (result) removeRecordingArtifactFromManifest(result, recording.relativePath);
    throw error;
  } finally {
    activeRecordingsByPid.delete(recording.pid);
    restoreActiveRecordingEnvironment(recording);
    cleanupRecordingStaging(recording.stagingDir);
  }
}

async function stopRecordingProcess(recording: ActiveRecipeRecording): Promise<void> {
  if (!recording.exited && !recording.child.stdin.destroyed) {
    recording.child.stdin.end('stop\n');
    await waitForRecordingExit(recording, 15_000);
  }
  if (!recording.exited) {
    recording.child.kill('SIGINT');
    await waitForRecordingExit(recording, 5_000);
  }
  if (!recording.exited) {
    recording.child.kill('SIGTERM');
    await waitForRecordingExit(recording, 3_000);
  }
  if (!recording.exited) {
    recording.child.kill('SIGKILL');
    await waitForRecordingExit(recording, 2_000);
  }
  if (!recording.exited) {
    throw new Error(
      `capture-helper recording process did not exit: pid=${recording.child.pid ?? 'unknown'}`,
    );
  }
}

async function waitForRecordingExit(
  recording: ActiveRecipeRecording,
  timeoutMs: number,
): Promise<void> {
  if (recording.exited) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      recording.child.removeListener('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    recording.child.once('close', finish);
    if (recording.exited) finish();
  });
}

async function waitForRecordingReady(
  recording: ActiveRecipeRecording,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!recording.frameReady && !recording.exited && Date.now() < deadline) {
    await sleep(50);
  }
}

function handleRecordingStderr(recording: ActiveRecipeRecording, chunk: string): void {
  recording.stderrBuffer += chunk;
  let newlineIndex = recording.stderrBuffer.indexOf('\n');
  while (newlineIndex !== -1) {
    const line = recording.stderrBuffer.slice(0, newlineIndex).trim();
    recording.stderrBuffer = recording.stderrBuffer.slice(newlineIndex + 1);
    if (line) handleRecordingEventLine(recording, line);
    newlineIndex = recording.stderrBuffer.indexOf('\n');
  }
}

function handleRecordingEventLine(recording: ActiveRecipeRecording, line: string): void {
  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    event = parsed as Record<string, unknown>;
  } catch {
    // capture-helper may emit human-readable stderr lines; only JSON event
    // records are relevant for in-session screenshot correlation.
    return;
  }
  if (
    event.type === 'info' &&
    typeof event.msg === 'string' &&
    /^record frames=[1-9]\d*$/.test(event.msg)
  ) {
    recording.frameReady = true;
  }
  if (event.output === recording.stagedPath)
    recording.interruption ??= parseCaptureHelperInterruption(event);
  if (captureHelperStreamStopped(event, recording.interruption)) {
    recording.streamStopped = true;
    // A cached session frame during finalization is stale. Pending commands are
    // resolved on close, after they can no longer overwrite the standalone image.
  }
  if (event.type === 'record_complete' && event.output === recording.stagedPath) {
    recording.completedVideo = typeof event.frames === 'number' && event.frames > 0;
    if (typeof event.recording_id === 'string') recording.completedRecordingId = event.recording_id;
  }
  const output = typeof event.output === 'string' ? event.output : undefined;
  if (!output) return;
  const pending = recording.pendingSnapshots.get(output);
  if (!pending) return;
  if (recording.streamStopped) return;
  if (event.type === 'snapshot') {
    clearTimeout(pending.timer);
    recording.pendingSnapshots.delete(output);
    pending.resolve(event);
    return;
  }
  if (event.type === 'error') {
    clearTimeout(pending.timer);
    recording.pendingSnapshots.delete(output);
    pending.reject(new Error(String(event.message ?? `capture-helper snapshot failed: ${output}`)));
  }
}

function rejectPendingSnapshots(recording: ActiveRecipeRecording, error: Error): void {
  for (const pending of recording.pendingSnapshots.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  recording.pendingSnapshots.clear();
}

async function validateRecordingArtifact(
  recording: ActiveRecipeRecording,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!fs.existsSync(recording.stagedPath)) {
    return { ok: false, reason: `missing output ${recording.stagedPath}` };
  }
  const stagedStat = fs.lstatSync(recording.stagedPath);
  if (stagedStat.isSymbolicLink() || !stagedStat.isFile()) {
    return { ok: false, reason: `unsafe non-regular output ${recording.stagedPath}` };
  }
  const size = stagedStat.size;
  if (size === 0) {
    return { ok: false, reason: `empty output ${recording.stagedPath}` };
  }
  const recorderOutput = `${recording.stdout}\n${recording.stderr}`;
  if (recording.nativeTiming) {
    if (!recording.completedVideo && !keptInterruption(recording))
      return { ok: false, reason: 'Missing finalized video completion' };
    recording.nativeTimingEvidence = await readNativeRecordingTiming(recording);
    return { ok: true };
  }
  if (!recorderOutput.includes('record_complete') && !keptInterruption(recording)) {
    return {
      ok: false,
      reason: `capture-helper did not report record_complete for ${recording.stagedPath}: ${recorderOutput.trim() || 'no recorder output'}`,
    };
  }

  const ffprobe = spawnSync(
    'ffprobe',
    [
      '-hide_banner',
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      recording.stagedPath,
    ],
    { encoding: 'utf8' },
  );
  if (ffprobe.error && (ffprobe.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return { ok: true };
  }
  if (ffprobe.error) {
    return {
      ok: false,
      reason: `ffprobe failed for ${recording.stagedPath}: ${ffprobe.error.message}`,
    };
  }
  if (ffprobe.status !== 0) {
    return {
      ok: false,
      reason: `invalid MP4 ${recording.stagedPath}: ${ffprobe.stderr.trim() || ffprobe.stdout.trim() || `ffprobe exited ${ffprobe.status}`}`,
    };
  }
  const durationSeconds = Number(ffprobe.stdout.trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { ok: false, reason: `MP4 has no positive duration: ${recording.stagedPath}` };
  }
  return { ok: true };
}

async function readNativeRecordingTiming(
  recording: ActiveRecipeRecording,
): ReturnType<typeof readCaptureHelperTiming> {
  try {
    const recordingId =
      recording.completedRecordingId ??
      (keptInterruption(recording) ? recording.interruption?.recordingId : undefined);
    if (!recordingId) throw new Error('Missing native recording completion identity');
    const sidecar = recording.stagedPath + '.timing.json';
    const entry = fs.lstatSync(sidecar);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error('Native timing must be a regular file');
    const native = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    if (native.recording_id !== recordingId) throw new Error('Native recording identity mismatch');
    return await readCaptureHelperTiming(recording.stagedPath);
  } catch (error) {
    // Timing is optional; retain finalized video without unverifiable markers.
    return { timingUnavailableReason: error instanceof Error ? error.message : String(error) };
  }
}

function preparePrivateRecordingDestination(
  artifactsDir: string,
  outputPath: string,
): {
  stagingDir: string;
  stagedPath: string;
} {
  const outputDir = path.dirname(outputPath);
  ensureRecordingDirectory(path.resolve(artifactsDir), outputDir);
  refuseRecordingDestinationSymlink(outputPath);
  const stagingDir = fs.mkdtempSync(path.join(outputDir, `.${harnessHost().name}-recording-`));
  fs.chmodSync(stagingDir, 0o700);
  return {
    stagingDir,
    stagedPath: path.join(stagingDir, 'full-run.mp4'),
  };
}

function ensureRecordingDirectory(artifactsRoot: string, outputDir: string): void {
  fs.mkdirSync(artifactsRoot, { recursive: true });
  requireRecordingDirectory(artifactsRoot);
  const relative = path.relative(artifactsRoot, outputDir);
  let current = artifactsRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    requireRecordingDirectory(current);
  }
}

function requireRecordingDirectory(directory: string): void {
  const entry = fs.lstatSync(directory);
  if (entry.isDirectory() && !entry.isSymbolicLink()) return;
  throw new Error(
    `Refusing unsafe recording artifact directory: ${directory}\n` +
      `Next: replace ${JSON.stringify(directory)} with a regular directory and retry the recipe.`,
  );
}

function publishRecordingArtifact(recording: ActiveRecipeRecording): void {
  publishPrivateRecordingFile(recording.stagedPath, recording.outputPath);
  if (recording.nativeTimingEvidence?.timing) {
    try {
      publishPrivateRecordingFile(
        recording.stagedPath + '.timing.json',
        recording.outputPath + '.timing.json',
      );
    } catch (error) {
      // A sidecar publication failure must not remove the finalized footage.
      recording.nativeTimingEvidence = {
        timingUnavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function publishPrivateRecordingFile(sourcePath: string, outputPath: string): void {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
    const stagedStat = fs.fstatSync(descriptor);
    if (!stagedStat.isFile()) {
      throw unsafeRecordingArtifactError(sourcePath);
    }
    fs.fchmodSync(descriptor, 0o600);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Next:')) throw error;
    throw unsafeRecordingArtifactError(
      sourcePath,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  refuseRecordingDestinationSymlink(outputPath);
  fs.renameSync(sourcePath, outputPath);
}

function refuseRecordingDestinationSymlink(outputPath: string): void {
  try {
    const destination = fs.lstatSync(outputPath);
    if (destination.isSymbolicLink()) {
      throw new Error(
        `Refusing recording artifact destination symlink: ${outputPath}\n` +
          `Next: rm -- ${JSON.stringify(outputPath)} and retry the recipe.`,
      );
    }
    if (!destination.isFile()) {
      throw new Error(
        `Refusing non-file recording artifact destination: ${outputPath}\n` +
          `Next: remove ${JSON.stringify(outputPath)} and retry the recipe.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function unsafeRecordingArtifactError(stagedPath: string, detail?: string): Error {
  return new Error(
    `Capture-helper recording output is not a safe regular file: ${stagedPath}${detail ? ` (${detail})` : ''}.\n` +
      'Next: capture-helper doctor --json',
  );
}

function cleanupRecordingStaging(stagingDir: string): void {
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch (error) {
    console.error(
      `WARN: could not remove capture-helper staging directory ${stagingDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function restoreActiveRecordingEnvironment(recording: ActiveRecipeRecording): void {
  if (process.env[recording.activePidEnv] !== String(recording.pid)) return;
  if (recording.previousActiveRecordingPid === undefined) {
    delete process.env[recording.activePidEnv];
    return;
  }
  process.env[recording.activePidEnv] = recording.previousActiveRecordingPid;
}

async function addRecordingArtifactToManifest(
  result: RecipeRunResult,
  recording: ActiveRecipeRecording,
): Promise<void> {
  const manifestPath = result.artifactManifestPath;
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    console.error(
      `WARN: cannot add video artifact to missing artifact manifest: ${manifestPath ?? '<unset>'}`,
    );
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    artifacts?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(manifest.artifacts)) manifest.artifacts = [];
  manifest.artifacts = manifest.artifacts.filter(
    (artifact) => artifact.path !== recording.relativePath,
  );
  const interruption = keptInterruption(recording);
  const timing = recording.nativeTiming
    ? (recording.nativeTimingEvidence ?? {
        timingUnavailableReason: 'Native recording timing unavailable',
      })
    : await optionalVideoTiming(recording.outputPath, {
        startedAtUnixMs: recording.startedAtUnixMs,
        stoppedAtUnixMs: recording.stoppedAtUnixMs ?? Date.now(),
      });
  if (recording.nativeTimingEvidence?.timing)
    manifest.artifacts.push({
      path: recording.relativePath + '.timing.json',
      type: 'json',
      category: 'system',
      label: 'Native recording and screenshot timing',
    });
  let timelinePath: string | undefined;
  let timelineUnavailableReason = timing.timingUnavailableReason;
  if (timing.timing) {
    try {
      const raw = JSON.parse(fs.readFileSync(result.tracePath, 'utf8'));
      const trace = Array.isArray(raw) ? raw : raw.entries;
      timelinePath = await writeRecordingTimeline(
        path.dirname(manifestPath),
        recording.relativePath,
        timing.timing,
        trace,
      );
      manifest.artifacts.push({
        path: timelinePath,
        type: 'json',
        label: 'Recording frames and action markers',
        category: 'system',
      });
    } catch (error) {
      // Keep valid footage when optional trace alignment cannot be established.
      timelineUnavailableReason = error instanceof Error ? error.message : String(error);
    }
  }
  manifest.artifacts.push({
    path: recording.relativePath,
    type: 'video',
    label: 'Full recipe replay video',
    category: 'evidence',
    mimeType: 'video/mp4',
    record: 'full_run',
    ...(timelinePath ? { timelinePath } : { timelineUnavailableReason }),
    ...(interruption ? { interruption } : {}),
    metadata: {
      provider: 'capture-helper',
      mode: 'full_run',
      pid: recording.pid,
    },
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function keptInterruption(recording: ActiveRecipeRecording) {
  return keptCaptureInterruption(recording.exitCode, recording.interruption);
}

function removeRecordingArtifactFromManifest(result: RecipeRunResult, relativePath: string): void {
  const manifestPath = result.artifactManifestPath;
  if (!manifestPath || !fs.existsSync(manifestPath)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    artifacts?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(manifest.artifacts)) return;
  const nextArtifacts = manifest.artifacts.filter((artifact) => artifact.path !== relativePath);
  if (nextArtifacts.length === manifest.artifacts.length) return;
  manifest.artifacts = nextArtifacts;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
