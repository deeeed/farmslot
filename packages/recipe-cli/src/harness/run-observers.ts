// The observers around one run or call: the run's network session, then the
// platform's performance observer, fed the same node events and closed in
// that order. They start inside the run's environment scope, on its ports.
import type { RecipeNodeEvent, RunObserver } from '@farmslot/adapter-sdk';

import { harnessAdapter } from './adapters.js';
import { startRunNetworkObservation } from './network-observation.js';

export interface RunObservers {
  onActionEvent(event: RecipeNodeEvent): void;
  /** Write and index every observer's artifacts, network first. */
  finalize(artifactManifestPath: string): Promise<void>;
  /** The run threw: close every observer without a manifest, ignoring their errors. */
  abandon(): Promise<void>;
}

export async function startRunObservers(
  adapter: string,
  target: string,
  artifactsDir: string,
): Promise<RunObservers> {
  const network = await startRunNetworkObservation(adapter, target, artifactsDir, process.env);
  const performance: RunObserver | undefined = await harnessAdapter(
    adapter,
  ).observation?.performance?.start({ target, artifactsDir, env: process.env });
  return {
    onActionEvent(event) {
      network?.onActionEvent(event);
      performance?.onActionEvent(event);
    },
    async finalize(artifactManifestPath) {
      await network?.finalize(artifactManifestPath);
      await performance?.finalize(artifactManifestPath);
    },
    async abandon() {
      await network?.finalize().catch(() => undefined);
      await performance?.finalize().catch(() => undefined);
    },
  };
}
