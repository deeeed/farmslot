// Video recording support every platform shares: the runner's recording-target
// provider (the platform resolves the target) and capture-helper capability checks.
import { spawnSync } from 'node:child_process';

import type {
  RecordingTarget,
  RecordingTargetContext,
  RecordingTargetProvider,
} from '@farmslot/recipe-runner';

import { harnessAdapter, harnessAdapters } from './adapters.js';

/** The runner's `--record-video` target, resolved by the adapter's `recording`. */
export function createRecordingTargetProvider(adapter: string): RecordingTargetProvider {
  return {
    async resolveRecordingTarget(context: RecordingTargetContext): Promise<RecordingTarget> {
      const recording = harnessAdapter(adapter).recording;
      // `run` and `call` refuse this before execution; the throw guards other callers.
      if (!recording) throw new Error(recordingUnsupportedMessage(adapter));
      return recording.target(context);
    },
  };
}

/**
 * The capability refusal for `--record-video` on an adapter whose harness
 * surface has no `recording`, or undefined when the adapter records.
 */
export function recordingUnsupported(
  adapter: string,
): { code: 'RECORDING_UNSUPPORTED'; message: string; userAction: string } | undefined {
  if (harnessAdapter(adapter).recording) return undefined;
  const registry = harnessAdapters();
  const recorders = registry.list().filter((id) => registry.get(id).recording);
  return {
    code: 'RECORDING_UNSUPPORTED',
    message: recordingUnsupportedMessage(adapter),
    userAction:
      'rerun without --record-video (or with --record-video=off) and capture screenshots in the recipe (ui.screenshot) as evidence; ' +
      (recorders.length > 0
        ? `adapters that support --record-video: ${recorders.join(', ')}`
        : 'no registered adapter supports --record-video'),
  };
}

/** The refusal a run failure carries when it came from the guard above. */
export function recordingUnsupportedFailure(
  output: string,
): ReturnType<typeof recordingUnsupported> {
  const adapter = /--record-video is not implemented for the (\S+) adapter\./u.exec(output)?.[1];
  return adapter && harnessAdapters().has(adapter) ? recordingUnsupported(adapter) : undefined;
}

function recordingUnsupportedMessage(adapter: string): string {
  return `--record-video is not implemented for the ${adapter} adapter.`;
}

export function captureHelperSupportsRecordSessionSnapshots(projectRoot: string): boolean {
  return captureHelperSupportsCapability(projectRoot, 'record_session_snapshot');
}

/** Whether `capture-helper version --json` lists `capability`. */
export function captureHelperSupportsCapability(projectRoot: string, capability: string): boolean {
  const result = spawnSync(captureHelperPath(), ['version', '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout) as { capabilities?: unknown };
    return Array.isArray(parsed.capabilities) && parsed.capabilities.includes(capability);
  } catch {
    return false;
  }
}

/** `CAPTURE_HELPER_PATH`, else `capture-helper` on PATH. */
export function captureHelperPath(): string {
  return process.env.CAPTURE_HELPER_PATH || 'capture-helper';
}
