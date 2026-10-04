// Video recording support every platform shares: the runner's recording-target
// provider (the platform resolves the target) and capture-helper capability checks.
import { spawnSync } from 'node:child_process';

import type {
  RecordingTarget,
  RecordingTargetContext,
  RecordingTargetProvider,
} from '@farmslot/recipe-runner';

import { harnessAdapter } from './adapters.js';

/** The runner's `--record-video` target, resolved by the adapter's `recording`. */
export function createRecordingTargetProvider(adapter: string): RecordingTargetProvider {
  return {
    async resolveRecordingTarget(context: RecordingTargetContext): Promise<RecordingTarget> {
      const recording = harnessAdapter(adapter).recording;
      if (!recording)
        throw new Error(`--record-video is not implemented for the ${adapter} adapter.`);
      return recording.target(context);
    },
  };
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
