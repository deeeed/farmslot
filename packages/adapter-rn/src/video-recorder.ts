import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  type ActiveVideoRecording,
  optionalVideoTiming,
  RecipeExecutionError,
  type VideoRecorder,
  type VideoRecorderDoctorResult,
  type VideoRecorderStartRequest,
} from '@farmslot/recipe-runner';

const RECORDING_START_TIMEOUT_MS = 5_000;
const RECORDING_STOP_TIMEOUT_MS = 10_000;
const RECORDING_TIME_LIMIT_SECONDS = 180;
const START_GRACE_MS = 1_000;
const HOST_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export function androidScreenrecordArgs(remotePath: string): string[] {
  return [
    'shell',
    'screenrecord',
    '--time-limit',
    String(RECORDING_TIME_LIMIT_SECONDS),
    remotePath,
  ];
}

export function createAndroidVideoRecorder(serial: string): VideoRecorder {
  return {
    name: 'adb-screenrecord',
    platform: 'android',
    doctor: async () => doctorAndroidRecorder(serial),
    start: (request) => startAndroidRecording(serial, request),
  };
}

function doctorAndroidRecorder(serial: string): VideoRecorderDoctorResult {
  const state = runAdb(serial, ['get-state']);
  if (state.status !== 0 || state.stdout.trim() !== 'device') {
    return {
      ok: false,
      code: 'android_device_unavailable',
      message: `Android device ${serial} is not ready: ${commandFailure(state)}`,
      suggestedFix: `Run adb -s ${serial} get-state and reconnect or unlock the device.`,
    };
  }
  const screenrecord = runAdb(serial, ['shell', 'screenrecord', '--help']);
  if (screenrecord.status !== 0) {
    return {
      ok: false,
      code: 'android_screenrecord_unavailable',
      message: `Android screenrecord is unavailable on ${serial}: ${commandFailure(screenrecord)}`,
      suggestedFix: `Run adb -s ${serial} shell screenrecord --help.`,
    };
  }
  return {
    ok: true,
    code: 'ok',
    message: `Android screen recording is ready on ${serial}.`,
  };
}

interface Segment {
  remotePath: string;
  child: ChildProcess;
  pid?: string;
  killed?: boolean;
  output: string;
  startedAtUnixMs: number;
  /** When the file first held bytes: the muxer writes its header only after the encoder's
   * first output, so the segment's frame zero precedes this. */
  zeroBoundAtUnixMs?: number;
  stoppedAtUnixMs?: number;
  exitCode?: number | null;
  exited: Promise<number | null>;
}

async function startAndroidRecording(
  serial: string,
  request: VideoRecorderStartRequest,
): Promise<ActiveVideoRecording> {
  if (request.target.kind !== 'android-device' || request.target.serial !== serial) {
    throw new Error('Android recording target does not match the selected device.');
  }
  const adb = (args: string[]) => runAdb(serial, args);
  const pollMs = 100;
  const host = process;
  const running = screenrecordPids(adb);
  if (running.length > 0) {
    throw new Error(
      `Android screenrecord is already running on ${serial} (pid ${running.join(', ')}). Stop that recording before retrying.`,
    );
  }
  const prefix = `/sdcard/Download/recipe-video-${randomUUID()}`;
  const segments: Segment[] = [];
  let stopping = false;
  let interruption: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  const localFiles = new Set<string>();
  const segmentFailure = (segment: Segment) =>
    `screenrecord on ${serial} stopped with exit ${segment.exitCode ?? 'error'}: ${segment.output.trim() || 'no recorder output'}`;

  const startSegment = async () => {
    const remotePath = `${prefix}-${segments.length}.mp4`;
    const startedAtUnixMs = Date.now();
    const child = spawn('adb', ['-s', serial, ...androidScreenrecordArgs(remotePath)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('error', (error) => {
        segment.output = error.message;
        resolve(null);
      });
      child.once('exit', (code) => resolve(code));
    });
    const segment: Segment = { remotePath, child, output: '', startedAtUnixMs, exited };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      segment.output = (segment.output + chunk).slice(-2000);
    });
    segments.push(segment);
    void exited.then((code) => {
      segment.stoppedAtUnixMs = Date.now();
      segment.exitCode = code;
      // stop() decides about the file it stopped.
      if (!segment.pid || segment.killed || interruption || stopping) return;
      if (code !== 0) {
        interruption = segmentFailure(segment);
        return;
      }
      chain = startSegment().catch((error: unknown) => {
        interruption ??= error instanceof Error ? error.message : String(error);
      });
    });
    const deadline = Date.now() + RECORDING_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (segment.stoppedAtUnixMs !== undefined) {
        throw new Error(
          `Android screenrecord exited before capture started on ${serial}: ${segment.output.trim() || 'no recorder output'}`,
        );
      }
      segment.pid ??= screenrecordPids(adb, remotePath)[0];
      // A started process has not necessarily captured a frame; its first file bytes have.
      if (segment.pid && remoteFileSize(adb, remotePath) > 0) {
        segment.zeroBoundAtUnixMs = Date.now();
        return;
      }
      await sleep(pollMs);
    }
    child.kill('SIGTERM');
    throw new Error(
      `Android screenrecord did not capture a frame on ${serial} within ${RECORDING_START_TIMEOUT_MS}ms.`,
    );
  };

  // Synchronous, so it also runs from a process 'exit' listener. A device file
  // is removed only once its screenrecord has exited: one still starting would
  // create it again. A unique output path identifies each owned process even
  // when a capture starts before its PID is observed.
  const stopOwnedRecorders = (terminateHostClients = false) => {
    const live = segments.filter((segment) => segment.stoppedAtUnixMs === undefined);
    for (const segment of live) segment.killed = true;
    if (live.length > 0) {
      const starting = live.some((segment) => !segment.pid);
      const graceUntil = Date.now() + (starting ? START_GRACE_MS : 0);
      const giveUpAt = Date.now() + RECORDING_STOP_TIMEOUT_MS;
      const signaled = new Set<string>();
      while (Date.now() < giveUpAt) {
        const pids = live.flatMap((segment) => screenrecordPids(adb, segment.remotePath));
        if (pids.length === 0 && Date.now() >= graceUntil) break;
        for (const pid of pids) {
          if (!signaled.has(pid)) adb(['shell', 'kill', '-2', pid]);
          signaled.add(pid);
        }
        sleepSync(pollMs);
      }
      if (terminateHostClients) for (const segment of live) segment.child.kill('SIGTERM');
    }
  };
  const abandon = () => {
    stopOwnedRecorders(true);
    if (segments.length > 0)
      adb(['shell', 'rm', '-f', ...segments.map((segment) => segment.remotePath)]);
    for (const localPath of localFiles) fs.rmSync(localPath, { force: true });
  };
  const onExit = () => abandon();
  const interrupt = (signal: (typeof HOST_SIGNALS)[number]) => {
    stopping = true;
    interruption = `Android recording interrupted by ${signal}.`;
    removeSignalGuards();
    if (host.listenerCount(signal) > 0) {
      // The CLI owns cancellation and calls stop() to retain partial evidence.
      stopOwnedRecorders();
    } else {
      abandon();
      removeGuards();
      host.kill(host.pid, signal);
    }
  };
  const signalHandlers = {
    SIGINT: () => interrupt('SIGINT'),
    SIGTERM: () => interrupt('SIGTERM'),
    SIGHUP: () => interrupt('SIGHUP'),
  };
  const removeSignalGuards = () => {
    for (const signal of HOST_SIGNALS) host.removeListener(signal, signalHandlers[signal]);
  };
  const removeGuards = () => {
    host.removeListener('exit', onExit);
    removeSignalGuards();
  };
  host.once('exit', onExit);
  for (const signal of HOST_SIGNALS) host.once(signal, signalHandlers[signal]);

  try {
    await startSegment();
  } catch (error) {
    stopping = true;
    abandon();
    removeGuards();
    throw error;
  }

  let stopped = false;
  return {
    // A 180 s roll restarts screenrecord; the restarted segment is ready once it bounds its zero.
    ready: () => chain,
    async stop() {
      if (stopped) throw new Error(`Android screen recording on ${serial} was already stopped.`);
      stopped = true;
      stopping = true;
      const stagingDir = path.dirname(request.outputPath);
      try {
        await chain;
        const tail = segments.at(-1)!;
        if (tail.stoppedAtUnixMs === undefined)
          for (const pid of screenrecordPids(adb, tail.remotePath))
            adb(['shell', 'kill', '-2', pid]);
        if (!(await settles(tail.exited, RECORDING_STOP_TIMEOUT_MS))) {
          tail.killed = true;
          tail.child.kill('SIGKILL');
          throw new Error(
            `Android screenrecord on ${serial} did not stop within ${RECORDING_STOP_TIMEOUT_MS}ms.`,
          );
        }
        // After a mid-run failure only the files that ended normally are kept.
        // Without one, a file stopped while screenrecord was still starting
        // can fail; the files before it still cover the run up to that restart.
        if (tail.exitCode !== 0) interruption ??= segmentFailure(tail);
        const kept = interruption
          ? segments.filter((segment) => segment.exitCode === 0)
          : tail.exitCode === 0
            ? segments
            : segments.slice(0, -1);
        if (kept.length === 0) {
          throw recordingFailure(
            interruption ? 'RECORDER_INTERRUPTED' : 'RECORDING_FAILED',
            interruption ?? segmentFailure(tail),
          );
        }

        fs.mkdirSync(stagingDir, { recursive: true });
        const recorded: Array<Segment & { localPath: string; bytes: number }> = [];
        for (const [index, segment] of kept.entries()) {
          const localPath =
            index === 0
              ? request.outputPath
              : path.join(
                  stagingDir,
                  `${path.parse(request.outputPath).name}.segment-${index}.mp4`,
                );
          localFiles.add(localPath);
          const pull = adb(['pull', segment.remotePath, localPath]);
          if (pull.status !== 0) {
            interruption ??= `Could not pull Android recording from ${serial}: ${commandFailure(pull)}`;
            break;
          }
          const bytes = fs.statSync(localPath).size;
          if (bytes > 0) recorded.push({ ...segment, localPath, bytes });
          else interruption ??= `Android recording output is empty: ${localPath}`;
        }
        if (recorded.length === 0)
          throw recordingFailure(
            interruption ? 'RECORDER_INTERRUPTED' : 'RECORDING_FAILED',
            interruption ?? `Android recording output is empty: ${request.outputPath}`,
          );
        const startedAtUnixMs = recorded[0].startedAtUnixMs;
        const placed = recorded.map((segment) => ({
          ...segment,
          offsetMs: segment.startedAtUnixMs - startedAtUnixMs,
        }));
        const timingEvidencePath = `${path.basename(request.outputPath)}.segments.json`;
        const timingEvidenceFile = path.join(stagingDir, timingEvidencePath);
        localFiles.add(timingEvidenceFile);
        fs.writeFileSync(
          timingEvidenceFile,
          `${JSON.stringify({
            recorder: 'adb-screenrecord',
            serial,
            segments: placed.map(
              ({ offsetMs, startedAtUnixMs, zeroBoundAtUnixMs, stoppedAtUnixMs, bytes }) => ({
                offsetMs,
                startedAtUnixMs,
                zeroBoundAtUnixMs,
                stoppedAtUnixMs,
                bytes,
              }),
            ),
          })}\n`,
        );
        const recorder = {
          name: 'adb-screenrecord',
          platform: 'android',
          target: { selector: 'adb-serial', value: serial },
        };
        const originals = await Promise.all(
          recorded.map(async (segment, index) => ({
            path: path.basename(segment.localPath),
            ...(index > 0 ? { gapBefore: true } : {}),
            // Frame zero lies between the spawn and the first file bytes. The process
            // lifetime bound would also span any static tail before the stop.
            ...(await optionalVideoTiming(segment.localPath, {
              clock: {
                source: 'adb-screenrecord-first-write',
                earliestZeroUnixMs: segment.startedAtUnixMs,
                latestZeroUnixMs: segment.zeroBoundAtUnixMs!,
              },
            })),
            timingEvidencePath,
            recorder,
          })),
        );
        // Returned originals belong to the shared runner's publication lifecycle.
        for (const segment of recorded) localFiles.delete(segment.localPath);
        localFiles.delete(timingEvidenceFile);
        return {
          segments: originals,
          ...(interruption
            ? {
                interruption: {
                  frames: originals.reduce(
                    (sum, segment) => sum + (segment.timing?.framesMs.length ?? 0),
                    0,
                  ),
                  mediaTimeMs:
                    placed.at(-1)!.offsetMs + (originals.at(-1)!.timing?.framesMs.at(-1) ?? 0),
                  cause: interruption,
                },
              }
            : {}),
        };
      } finally {
        abandon();
        removeGuards();
      }
    },
  };
}

function screenrecordPids(
  adb: (args: string[]) => ReturnType<typeof runAdb>,
  remotePath?: string,
): string[] {
  const result = adb(['shell', 'pidof', 'screenrecord']);
  if (result.status !== 0) return [];
  const pids = result.stdout.trim().split(/\s+/u).filter(Boolean);
  if (!remotePath) return pids;
  return pids.filter((pid) => {
    if (!/^\d+$/u.test(pid)) throw new Error(`Invalid Android screenrecord pid: ${pid}`);
    const command = adb(['shell', 'cat', `/proc/${pid}/cmdline`]);
    if (command.status !== 0) {
      // The recorder can exit between pidof and the ownership read.
      if (!screenrecordPids(adb).includes(pid)) return false;
      throw new Error(`Could not verify Android recorder ownership: ${commandFailure(command)}`);
    }
    return command.stdout.split('\0').includes(remotePath);
  });
}

function remoteFileSize(
  adb: (args: string[]) => ReturnType<typeof runAdb>,
  remotePath: string,
): number {
  const result = adb(['shell', 'stat', '-c', '%s', remotePath]);
  const size = Number(result.stdout.trim());
  return result.status === 0 && Number.isFinite(size) ? size : 0;
}

function settles(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function recordingFailure(
  code: 'RECORDER_INTERRUPTED' | 'RECORDING_FAILED',
  cause: string,
): RecipeExecutionError {
  return new RecipeExecutionError('environment', `${code}: ${cause}`, { code, details: { cause } });
}

function runAdb(serial: string, args: string[]) {
  return spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 60_000 });
}

function commandFailure(result: ReturnType<typeof runAdb>): string {
  return (
    result.error?.message ||
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    `exit ${result.status ?? 'unknown'}`
  );
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
