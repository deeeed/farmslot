// The observers around one run or call: the run's network session, then the
// platform's performance observer, fed the same node events and closed in
// that order. They start inside the run's environment scope, on its ports.
import path from 'node:path';

import type { RecipeNodeEvent, RunObserver } from '@farmslot/adapter-sdk';
import type { RecipeArtifactManifestDocument } from '@farmslot/protocol';
import type { RecipeArtifactFinalization } from '@farmslot/recipe-runner';

import { harnessAdapter } from './adapters.js';
import { readContainedJsonArtifact, writeContainedArtifact } from './artifact-files.js';
import { startRunNetworkObservation } from './network-observation.js';

export interface RunObservers {
  onActionEvent(event: RecipeNodeEvent): void;
  /** Write and index every observer's artifacts, network first. */
  finalize(context: RecipeArtifactFinalization): Promise<void>;
  /** The run threw: close every observer without a manifest, ignoring their errors. */
  abandon(): Promise<void>;
}

export async function startRunObservers(
  adapter: string,
  target: string,
  artifactsDir: string,
): Promise<RunObservers> {
  // The run's environment as the observers start: they keep it, whatever the
  // run's actions change later.
  const env = { ...process.env };
  const network = await startRunNetworkObservation(adapter, target, artifactsDir, env);
  const performance: RunObserver | undefined = await harnessAdapter(
    adapter,
  ).observation?.performance?.start({ target, artifactsDir, env });
  return {
    onActionEvent(event) {
      network?.onActionEvent(event);
      performance?.onActionEvent(event);
    },
    async finalize(context) {
      if (!network && !performance) return;
      // Existing providers index a manifest path. Give them an observer sidecar;
      // only the engine writes the canonical package manifest, after closeout.
      const relativePath = 'observer-artifacts.json';
      await writeContainedArtifact(
        artifactsDir,
        relativePath,
        JSON.stringify({ version: 1, artifacts: context.artifacts() }),
        'Observer artifact inventory',
      );
      const observerManifestPath = path.join(artifactsDir, relativePath);
      await network?.finalize(observerManifestPath);
      await performance?.finalize(observerManifestPath);
      const inventory = await readContainedJsonArtifact<RecipeArtifactManifestDocument>(
        artifactsDir,
        relativePath,
        8 * 1024 * 1024,
        'Observer artifact inventory',
      );
      for (const entry of inventory.artifacts) context.register(entry);
      context.register({
        path: relativePath,
        type: 'json',
        label: 'Observer artifact inventory',
        category: 'diagnostic',
      });
    },
    async abandon() {
      await network?.finalize().catch(() => undefined);
      await performance?.finalize().catch(() => undefined);
    },
  };
}
