import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  type ActiveVideoRecording,
  optionalVideoTiming,
  type VideoRecorder,
  type VideoRecorderDoctorResult,
  type VideoRecorderStartRequest,
} from '@farmslot/recipe-runner';

const RECORDING_START_TIMEOUT_MS = 5_000;
const RECORDING_STOP_TIMEOUT_MS = 10_000;
const RECORDING_TIME_LIMIT_SECONDS = 0;

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

async function startAndroidRecording(
  serial: string,
  request: VideoRecorderStartRequest,
): Promise<ActiveVideoRecording> {
  const targetSerial = androidTargetSerial(request);
  if (targetSerial !== serial) {
    throw new Error(
      `Android recording target ${targetSerial ?? '<missing>'} does not match selected device ${serial}.`,
    );
  }
  const existingPid = screenrecordPid(serial);
  if (existingPid) {
    throw new Error(
      `Android screenrecord is already running on ${serial} (pid ${existingPid}). Stop that recording before retrying.`,
    );
  }

  const remotePath = `/sdcard/Download/recipe-video-${Date.now()}-${process.pid}.mp4`;
  const startedAtUnixMs = Date.now();
  const child = spawn('adb', ['-s', serial, ...androidScreenrecordArgs(remotePath)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  child.stdout?.resume();

  const recorderPid = await waitForScreenrecordStart(serial, child, stderr);
  let stopped = false;
  return {
    async stop() {
      if (stopped) {
        throw new Error(`Android screen recording on ${serial} was already stopped.`);
      }
      stopped = true;
      try {
        stopRemoteScreenrecord(serial, recorderPid);
        await waitForChildExit(child, RECORDING_STOP_TIMEOUT_MS, 'Android screenrecord');
        const stoppedAtUnixMs = Date.now();
        fs.mkdirSync(path.dirname(request.outputPath), { recursive: true });
        const pull = runAdb(serial, ['pull', remotePath, request.outputPath]);
        if (pull.status !== 0) {
          throw new Error(
            `Could not pull Android recording from ${serial}: ${commandFailure(pull)}`,
          );
        }
        const output = fs.statSync(request.outputPath);
        if (!output.isFile() || output.size <= 0) {
          throw new Error(`Android recording output is empty: ${request.outputPath}`);
        }
        return {
          segments: [
            {
              path: path.basename(request.outputPath),
              ...(await optionalVideoTiming(request.outputPath, {
                startedAtUnixMs,
                stoppedAtUnixMs,
              })),
              recorder: {
                name: 'adb-screenrecord',
                platform: 'android',
                target: { selector: 'adb-serial', value: serial },
              },
            },
          ],
        };
      } finally {
        runAdb(serial, ['shell', 'rm', '-f', remotePath]);
      }
    },
  };
}

function androidTargetSerial(request: VideoRecorderStartRequest): string | undefined {
  return request.target.kind === 'android-device' ? request.target.serial : undefined;
}

async function waitForScreenrecordStart(
  serial: string,
  child: ChildProcess,
  stderr: string[],
): Promise<string> {
  const deadline = Date.now() + RECORDING_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Android screenrecord exited before capture started (exit ${child.exitCode}): ${stderr.join('').trim() || 'no recorder output'}`,
      );
    }
    const pid = screenrecordPid(serial);
    if (pid) return pid;
    await sleep(100);
  }
  child.kill('SIGTERM');
  throw new Error(
    `Android screenrecord did not start on ${serial} within ${RECORDING_START_TIMEOUT_MS}ms.`,
  );
}

function stopRemoteScreenrecord(serial: string, pid: string): void {
  const stop = runAdb(serial, ['shell', 'kill', '-2', pid]);
  if (stop.status !== 0 && screenrecordPid(serial) === pid) {
    throw new Error(`Could not stop Android screenrecord pid ${pid}: ${commandFailure(stop)}`);
  }
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
  recorderName: string,
): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${recorderName} did not stop within ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function screenrecordPid(serial: string): string | undefined {
  const result = runAdb(serial, ['shell', 'pidof', 'screenrecord']);
  if (result.status !== 0) return undefined;
  return result.stdout.trim().split(/\s+/u).find(Boolean);
}

function runAdb(serial: string, args: string[]) {
  return spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8' });
}

function commandFailure(result: ReturnType<typeof runAdb>): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
