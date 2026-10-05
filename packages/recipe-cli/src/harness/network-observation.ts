// Network observation around a run: the platform's capture backend
// (`observation.network`), an automatic whole-run capture summarized per node,
// and the `app.network_capture` windows recipes open on the same session.
import path from 'node:path';

import type { NetworkCaptureBackend, RunObserver } from '@farmslot/adapter-sdk';
import type { ActionExecutionContext, ActionResult } from '@farmslot/recipe-runner';

import { harnessAdapter } from './adapters.js';
import { indexArtifactManifest, writeContainedArtifact } from './artifact-files.js';
import { hostEnvName } from './host.js';

const AUTO_CAPTURE_ID = 'run-network';
const AUTO_ARTIFACT_PATH = 'network/run-summary.json';

interface NodeEvent {
  action: string;
  epochMs: number;
  nodeId: string;
  status: 'running' | 'passed' | 'failed';
}

interface ObservationSession {
  // The adapter whose backend the session opened; it names the observation in errors.
  adapter: string;
  artifactsDir: string;
  backend?: NetworkCaptureBackend;
  setupError?: string;
  autoStarted: boolean;
  autoStartedAt: number;
  nodeEvents: NodeEvent[];
}

const sessions = new Map<string, ObservationSession>();

/**
 * Open the run's network session on the platform's backend and, unless the
 * host's `AUTO_NETWORK_CAPTURE` is `0`, capture the whole run. Undefined when
 * the platform observes no network.
 */
export async function startRunNetworkObservation(
  adapter: string,
  target: string,
  artifactsDir: string,
  env: NodeJS.ProcessEnv,
): Promise<RunObserver | undefined> {
  const network = harnessAdapter(adapter).observation?.network;
  if (!network) return undefined;
  const autoCapture = env[hostEnvName('AUTO_NETWORK_CAPTURE')] !== '0';
  const key = path.resolve(artifactsDir);
  const session: ObservationSession = {
    adapter,
    artifactsDir: key,
    autoStarted: false,
    autoStartedAt: Date.now(),
    nodeEvents: [],
  };
  sessions.set(key, session);

  try {
    session.backend = await network.backend(target, env, key);
  } catch (error) {
    session.setupError = boundedError(error);
  }

  if (autoCapture) {
    session.autoStartedAt = Date.now();
    if (session.backend) {
      try {
        await session.backend.start({
          id: AUTO_CAPTURE_ID,
          bodyJsonFields: ['type'],
          maxDurationMs: 60 * 60 * 1000,
          maxRequests: 10_000,
          methods: [],
          urlIncludes: [],
        });
        session.autoStarted = true;
      } catch (error) {
        session.setupError = boundedError(error);
      }
    }
  }

  return {
    onActionEvent(event) {
      session.nodeEvents.push({ ...event, epochMs: Date.now() });
    },
    async finalize(artifactManifestPath) {
      try {
        if (autoCapture) {
          const summary = await automaticSummary(session);
          await writeSummary(key, AUTO_ARTIFACT_PATH, summary);
          if (artifactManifestPath) {
            await indexArtifactManifest(artifactManifestPath, [
              {
                path: AUTO_ARTIFACT_PATH,
                type: 'report',
                label: 'Automatic network observation',
                category: 'diagnostic',
              },
            ]);
          }
        }
      } finally {
        sessions.delete(key);
        await session.backend?.close();
      }
    },
  };
}

/**
 * `app.network_capture phase=start|end id=<id>` on the run's session: start a
 * filtered capture window, or end it and write its summary artifact. `adapter`
 * is the platform dispatching the action; it names the observation when the
 * run opened no session.
 */
export async function runNetworkCaptureAction(
  adapter: string,
  node: Record<string, unknown>,
  context: ActionExecutionContext,
): Promise<ActionResult> {
  const action = 'app.network_capture';
  const phase = String(node.phase ?? '').toLowerCase();
  const id = String(node.id ?? '').trim();
  if (!['start', 'end'].includes(phase) || !id) {
    throw new Error('app.network_capture requires phase=start|end and a non-empty id.');
  }
  const session = sessions.get(path.resolve(context.artifactsDir));
  if (!session?.backend) {
    throw new Error(
      `${capitalize(session?.adapter ?? adapter)} network observation is unavailable: ${session?.setupError ?? 'run observer was not started'}.`,
    );
  }
  if (phase === 'start') {
    const result = await session.backend.start(captureParams(id, node));
    return {
      output: {
        action,
        phase,
        ...asRecord(result),
      },
    };
  }

  const artifactPath = String(node.artifact_path ?? `network/${id}-summary.json`);
  const summary = await session.backend.end(id);
  await writeSummary(context.artifactsDir, artifactPath, summary);
  return {
    output: {
      action,
      phase,
      ...summary,
    },
    artifacts: [
      {
        path: artifactPath,
        type: 'report',
        nodeId: context.nodeId,
      },
    ],
  };
}

async function automaticSummary(session: ObservationSession): Promise<Record<string, unknown>> {
  let summary: Record<string, unknown>;
  if (session.autoStarted && session.backend) {
    try {
      summary = await session.backend.end(AUTO_CAPTURE_ID);
    } catch (error) {
      summary = unavailableSummary(session.autoStartedAt, boundedError(error));
    }
  } else {
    summary = unavailableSummary(
      session.autoStartedAt,
      session.setupError ?? 'Network observer did not start.',
    );
  }
  const startedAt = Number(summary.startedAtEpochMs ?? session.autoStartedAt);
  return {
    ...summary,
    nodeEvents: session.nodeEvents.map((event) => ({
      action: event.action,
      elapsedMs: Math.max(0, event.epochMs - startedAt),
      nodeId: event.nodeId,
      status: event.status,
    })),
  };
}

function unavailableSummary(startedAtEpochMs: number, reason: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: AUTO_CAPTURE_ID,
    status: 'unavailable',
    startedAtEpochMs,
    endedAtEpochMs: Date.now(),
    maxDurationMs: 60 * 60 * 1000,
    reconnects: 0,
    droppedRequests: 0,
    unavailableReasons: [reason],
    coverageGapReasons: [],
    uninspectableBodyRequests: 0,
    projectedBodyFields: ['type'],
    totalRequests: 0,
    requestsByMethod: {},
    requestsByHost: {},
    requestsByType: {},
    requests: [],
  };
}

function captureParams(id: string, node: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    urlIncludes: node.url_includes ?? [],
    methods: node.methods ?? [],
    bodyJsonFields: node.body_json_fields ?? [],
    maxRequests: node.max_requests,
    maxDurationMs: node.max_duration_ms,
  };
}

async function writeSummary(
  artifactsDir: string,
  relativePath: string,
  summary: Record<string, unknown>,
): Promise<void> {
  await writeContainedArtifact(
    artifactsDir,
    relativePath,
    `${JSON.stringify(summary, null, 2)}\n`,
    'Network artifact',
  );
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function boundedError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 256);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
