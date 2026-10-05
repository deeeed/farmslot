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

// Recording target ids: `android-device:<serial>` and `ios-simulator:<udid>`.
export const ANDROID_RECORDING_TARGET_PREFIX = 'android-device:';
export const IOS_SIMULATOR_RECORDING_TARGET_PREFIX = 'ios-simulator:';

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

export function createIosSimulatorVideoRecorder(simulator: string): VideoRecorder {
  return {
    name: 'simctl-recordVideo',
    platform: 'ios',
    doctor: async () => doctorIosSimulatorRecorder(simulator),
    start: (request) => startIosSimulatorRecording(simulator, request),
  };
}

function doctorIosSimulatorRecorder(simulator: string): VideoRecorderDoctorResult {
  const state = runSimctl(['getenv', simulator, 'SIMULATOR_UDID']);
  if (state.status !== 0 || !state.stdout.trim()) {
    return {
      ok: false,
      code: 'ios_simulator_unavailable',
      message: `iOS simulator ${simulator} is not booted: ${commandFailure(state)}`,
      suggestedFix: `Boot ${simulator} and run xcrun simctl getenv ${simulator} SIMULATOR_UDID.`,
    };
  }
  return {
    ok: true,
    code: 'ok',
    message: `iOS simulator recording is ready on ${simulator}.`,
  };
}

async function startIosSimulatorRecording(
  simulator: string,
  request: VideoRecorderStartRequest,
): Promise<ActiveVideoRecording> {
  const targetSimulator = iosTargetSimulator(request);
  if (targetSimulator !== simulator) {
    throw new Error(
      `iOS recording target ${targetSimulator ?? '<missing>'} does not match selected simulator ${simulator}.`,
    );
  }

  fs.mkdirSync(path.dirname(request.outputPath), { recursive: true });
  const child = spawn(
    'xcrun',
    ['simctl', 'io', simulator, 'recordVideo', '--codec=h264', '--force', request.outputPath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output: string[] = [];
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));

  await waitForIosRecordingStart(child, output);
  let stopped = false;
  return {
    async stop() {
      if (stopped) {
        throw new Error(`iOS simulator recording on ${simulator} was already stopped.`);
      }
      stopped = true;
      child.kill('SIGINT');
      await waitForChildExit(child, RECORDING_STOP_TIMEOUT_MS, 'iOS simulator recordVideo');
      const recorded = fs.statSync(request.outputPath);
      if (!recorded.isFile() || recorded.size <= 0) {
        throw new Error(`iOS simulator recording output is empty: ${request.outputPath}`);
      }
      return {
        recorder: {
          name: 'simctl-recordVideo',
          platform: 'ios',
          target: { selector: 'simulator', value: simulator },
        },
      };
    },
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
          ...(await optionalVideoTiming(request.outputPath, { startedAtUnixMs, stoppedAtUnixMs })),
          recorder: {
            name: 'adb-screenrecord',
            platform: 'android',
            target: { selector: 'adb-serial', value: serial },
          },
        };
      } finally {
        runAdb(serial, ['shell', 'rm', '-f', remotePath]);
      }
    },
  };
}

function androidTargetSerial(request: VideoRecorderStartRequest): string | undefined {
  if (request.target.kind === 'android-device') return request.target.serial;
  if (request.target.kind !== 'window-id') return undefined;
  if (!request.target.windowId.startsWith(ANDROID_RECORDING_TARGET_PREFIX)) return undefined;
  return request.target.windowId.slice(ANDROID_RECORDING_TARGET_PREFIX.length) || undefined;
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

async function waitForIosRecordingStart(child: ChildProcess, output: string[]): Promise<void> {
  const deadline = Date.now() + RECORDING_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `iOS simulator recordVideo exited before capture started (exit ${child.exitCode}): ${output.join('').trim() || 'no recorder output'}`,
      );
    }
    if (output.join('').includes('Recording started')) return;
    await sleep(100);
  }
  if (child.exitCode === null) return;
  throw new Error(
    `iOS simulator recordVideo did not start within ${RECORDING_START_TIMEOUT_MS}ms.`,
  );
}

function iosTargetSimulator(request: VideoRecorderStartRequest): string | undefined {
  if (request.target.kind !== 'window-id') return undefined;
  if (!request.target.windowId.startsWith(IOS_SIMULATOR_RECORDING_TARGET_PREFIX)) {
    return undefined;
  }
  return request.target.windowId.slice(IOS_SIMULATOR_RECORDING_TARGET_PREFIX.length) || undefined;
}

function screenrecordPid(serial: string): string | undefined {
  const result = runAdb(serial, ['shell', 'pidof', 'screenrecord']);
  if (result.status !== 0) return undefined;
  return result.stdout.trim().split(/\s+/u).find(Boolean);
}

function runAdb(serial: string, args: string[]) {
  return spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8' });
}

function runSimctl(args: string[]) {
  return spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8' });
}

function commandFailure(result: ReturnType<typeof runAdb>): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
