import path from 'node:path';

import type { Run, RunStep } from '@farmslot/protocol';

import { digest, textDigest } from '../../assessment/failure-triage/packet.js';
import type { TriagePacket } from '../../assessment/failure-triage/types.js';
import {
  findRegisteredLogEntry,
  listLogRegistryEntries,
} from '../../observability/log-registry.js';
import { getRunWithArchived } from '../../runs/store.js';

import { readTriageFile, type TriagePolicy } from './policy.js';

export class TriageSnapshotUnavailable extends Error {
  constructor(
    readonly reason: 'no-recorded-failure' | 'rejected-data',
    message: string,
  ) {
    super(message);
  }
}

function failureLogPaths(step: RunStep): string[] {
  return [
    ...new Set(
      Object.values(step.outputs ?? {}).filter(
        (value): value is string =>
          typeof value === 'string' &&
          path.isAbsolute(value) &&
          /\.(log|out|err|txt|ndjson)$/.test(value),
      ),
    ),
  ]
    .sort()
    .slice(0, 16);
}

export function triageFailureHash(run: Run, step: RunStep): string {
  return digest({
    runId: run.id,
    project: run.project,
    flowType: run.flowType,
    step: {
      name: step.name,
      status: step.status,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      detail: step.detail,
      logPaths: failureLogPaths(step),
    },
  });
}

/** Host-wide registry plus nested runtime logs disclosed by canonical step outputs. */
export async function registeredFailureLogs(step: RunStep) {
  const registry = await listLogRegistryEntries();
  const paths = failureLogPaths(step);
  for (const candidate of paths) {
    const entry = await findRegisteredLogEntry(candidate, registry);
    if (entry && !registry.some((e) => e.id === entry.id)) registry.push(entry);
  }
  return registry;
}

export async function admittedFailureSnapshot(
  runId: string,
  stepName: string | undefined,
  policy: Extract<TriagePolicy, { enabled: true }>,
) {
  const run = await getRunWithArchived(runId);
  const step = run?.steps
    .filter((s) => s.status === 'failed' && (!stepName || s.name === stepName))
    .at(-1);
  if (!run || run.flowType !== 'dev' || !step)
    throw new TriageSnapshotUnavailable(
      'no-recorded-failure',
      'Select a recorded failed development step.',
    );
  if (!policy.projects.includes(run.project))
    throw new TriageSnapshotUnavailable('rejected-data', 'Triage is not enabled for this project.');
  const failureHash = triageFailureHash(run, step);
  const approval = policy.approvals.find(
    (a) =>
      a.runId === run.id &&
      a.project === run.project &&
      a.step === step.name &&
      a.failureHash === failureHash,
  );
  if (!approval)
    throw new TriageSnapshotUnavailable(
      'rejected-data',
      'This failure has no approved public or synthetic source snapshot.',
    );
  const identity = { runId: run.id, project: run.project, step: step.name, failureHash };
  const registry = await registeredFailureLogs(step);
  const packet: TriagePacket = {
    version: 1,
    caseId: run.id,
    failure: { runId: run.id, status: 'failed', step: step.name },
    evidence: [],
  };
  const sources: Array<{ id: string; sourceId: string; digest: string }> = [];
  for (const [index, source] of approval.sources.entries()) {
    // IDs only. Do not accept the registry's path/alias fallback from a manifest.
    const entry = registry.find((e) => e.id === source.logId && e.exists);
    if (!entry)
      throw new TriageSnapshotUnavailable(
        'rejected-data',
        'An approved source is no longer registered.',
      );
    let text: string;
    try {
      text = await readTriageFile(entry.path, 12000);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        ['ENOENT', 'EACCES', 'EPERM', 'ERR_ENCODING_INVALID_ENCODED_DATA'].includes(code ?? '') ||
        (error instanceof Error &&
          ['Triage source exceeds its byte limit', 'Triage source is not a file'].includes(
            error.message,
          ))
      )
        throw new TriageSnapshotUnavailable(
          'rejected-data',
          'An approved source is unavailable, oversized or invalid UTF-8.',
        );
      throw error;
    }
    const contentHash = textDigest(text);
    if (contentHash !== source.digest)
      throw new TriageSnapshotUnavailable(
        'rejected-data',
        'Source content changed since approval.',
      );
    const id = `e${index + 1}`;
    packet.evidence.push({ id, text, digest: contentHash, required: true });
    sources.push({ id, sourceId: entry.id, digest: contentHash });
  }
  // Bind origin and policy locally. Neither reference metadata nor approvals enter model input.
  const snapshotHash = digest({
    ...identity,
    packet,
    sources,
    origin: approval.origin,
    approval,
    price: policy.price,
  });
  return { ...identity, packet, sources, snapshotHash };
}
