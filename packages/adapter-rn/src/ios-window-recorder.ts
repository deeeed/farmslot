// Record only the selected simulator's unique visible window; retain native capture when unavailable.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { captureHelperPath } from '@farmslot/protocol/node/capture-helper-path';
import {
  createCaptureHelperVideoRecorder,
  errorMessage,
  manifestTarget,
  type RecordingTarget,
  type VideoRecorder,
  type VideoRecorderDoctorOptions,
} from '@farmslot/recipe-runner';

import { type DeviceDiscoveryError, listIosSimulators } from './devices.js';

const exec = promisify(execFile);
type WindowTarget = Extract<RecordingTarget, { kind: 'window-id' }>;
type Selection =
  | { kind: 'window'; target: WindowTarget; recorder: VideoRecorder }
  | { kind: 'native'; reason: string };
interface HostCapture {
  path: string;
  recorder: VideoRecorder;
}

export function createVisibleSimulatorRecorder(
  simulator: string,
  fallback: VideoRecorder,
): VideoRecorder {
  let helper: HostCapture | undefined;
  let selection: Selection | undefined;
  let recording: { outputPath: string; selection: Selection } | undefined;

  const select = async (options?: VideoRecorderDoctorOptions): Promise<Selection> => {
    const errors: DeviceDiscoveryError[] = [];
    const devices = listIosSimulators('available', errors);
    const discoveryError = errors[0];
    if (discoveryError)
      return (selection = {
        kind: 'native',
        reason: `${discoveryError.message} Check: ${discoveryError.userAction}`,
      });
    const booted = devices.filter((device) => device.state === 'Booted');
    const matches = devices.filter(
      (device) =>
        device.id === simulator ||
        device.name === simulator ||
        (simulator === 'booted' && device.state === 'Booted' && booted.length === 1),
    );
    const device = matches.length === 1 ? matches[0] : undefined;
    if (
      !device?.name ||
      device.state !== 'Booted' ||
      devices.filter((entry) => entry.name === device.name).length !== 1
    ) {
      return (selection = {
        kind: 'native',
        reason: 'No unique booted simulator name maps the selected device to a host window.',
      });
    }
    if (!helper) {
      const helperPath = captureHelperPath();
      helper = {
        path: helperPath,
        recorder: createCaptureHelperVideoRecorder({
          captureHelperPath: helperPath,
          captureSlotWaitMs: 0,
        }),
      };
    }
    const host = helper;
    const ready = await host.recorder.doctor?.(options);
    if (!ready?.ok)
      return (selection = {
        kind: 'native',
        reason: ready?.message ?? 'Capture-helper is unavailable.',
      });
    try {
      const list = await exec(host.path, ['list', '--json', '--on-screen', '--capturable'], {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
        signal: options?.signal,
      });
      const document: unknown = JSON.parse(list.stdout);
      if (!isRecord(document) || !Array.isArray(document.windows))
        throw new Error('Capture-helper returned an invalid window list.');
      const windows = document.windows.filter(
        (window: unknown): window is Record<string, unknown> =>
          isRecord(window) &&
          ['Simulator', 'Device Hub'].includes(String(window.app)) &&
          window.title === device.name &&
          window.onScreen === true &&
          typeof window.id === 'number' &&
          Number.isInteger(window.id) &&
          window.id > 0,
      );
      if (windows.length === 1)
        return (selection = {
          kind: 'window',
          target: { kind: 'window-id', windowId: String(windows[0]!.id) },
          recorder: host.recorder,
        });
      return (selection = {
        kind: 'native',
        reason: 'The selected simulator has no unique visible capture window.',
      });
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      // Native capture preserves headless/permission-limited operation; retain why it was selected.
      return (selection = {
        kind: 'native',
        reason: `Simulator window capture unavailable: ${errorMessage(error)}`,
      });
    }
  };

  return {
    get name() {
      return selection?.kind === 'window' ? 'capture-helper' : fallback.name;
    },
    platform: 'ios',
    async doctor(options) {
      const selected = await select(options);
      if (selected.kind === 'window')
        return {
          ok: true,
          code: 'ok',
          message: 'Capture-helper can record the selected simulator window.',
        };
      const result = (await fallback.doctor?.(options)) ?? {
        ok: true,
        code: 'ok',
        message: 'Native simulator recorder selected.',
      };
      return { ...result, message: `${result.message} ${selected.reason}` };
    },
    async start(request) {
      if (request.target.kind !== 'simulator' || request.target.device !== simulator)
        throw new Error('Recording target differs from the selected simulator.');
      // Segment rotation changes only the suffix. Keep capabilities and window identity
      // stable until the next independent recording; a closed window must fail at the helper.
      const segmentPrefix = recording?.outputPath.replace(/\.mp4$/u, '-segment-');
      const segment =
        segmentPrefix &&
        request.outputPath.startsWith(segmentPrefix) &&
        /^\d+\.mp4$/u.test(request.outputPath.slice(segmentPrefix.length));
      const selected =
        segment && recording ? recording.selection : await select({ signal: request.signal });
      if (!segment) recording = { outputPath: request.outputPath, selection: selected };
      const active = await (selected.kind === 'window'
        ? selected.recorder.start({ ...request, target: selected.target })
        : fallback.start(request));
      const snapshot = active.snapshot?.bind(active);
      const ready = active.ready?.bind(active);
      return {
        ...(snapshot ? { snapshot } : {}),
        ...(ready ? { ready } : {}),
        async stop() {
          const result = await active.stop();
          return {
            ...result,
            segments: result.segments.map((segment) => ({
              ...segment,
              recorder: {
                ...segment.recorder,
                platform: 'ios',
                target: manifestTarget(request.target),
                ...(selected.kind === 'window'
                  ? { mirrorWindowId: selected.target.windowId }
                  : { fallbackReason: selected.reason }),
              },
            })),
          };
        },
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
