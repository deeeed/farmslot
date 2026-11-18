import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import type { RunArtifactSearchParams, RunArtifactSearchResult } from '@farmslot/protocol';

import { getRun } from '../../runs/store.js';
import { resolveRetainedRunArtifact, retainedRunArtifactRef } from '../filesystem.js';

import { searchArtifactText } from './artifact-search.js';

export async function runSearchArtifacts(
  params: RunArtifactSearchParams,
): Promise<RunArtifactSearchResult> {
  if (
    !params ||
    typeof params.runId !== 'string' ||
    typeof params.query !== 'string' ||
    !Array.isArray(params.paths) ||
    params.paths.length > 500 ||
    params.paths.some((p) => typeof p !== 'string' || p.length > 1024) ||
    (params.bundleDigest !== undefined && typeof params.bundleDigest !== 'string') ||
    (params.recipeRunId !== undefined && typeof params.recipeRunId !== 'string') ||
    (params.decisionId !== undefined && typeof params.decisionId !== 'string') ||
    (params.versions !== undefined &&
      (!params.versions ||
        typeof params.versions !== 'object' ||
        Array.isArray(params.versions) ||
        Object.keys(params.versions).length > 500 ||
        Object.values(params.versions).some(
          (value) => typeof value !== 'string' || value.length > 80,
        )))
  )
    throw new Error('Invalid artifact search parameters.');
  const run = getRun(params.runId);
  if (!run) throw new Error('Run not found.');
  const selectors = new URLSearchParams();
  if (params.bundleDigest) selectors.set('bundleDigest', params.bundleDigest);
  if (params.decisionId) selectors.set('decisionId', params.decisionId);
  if (params.recipeRunId) selectors.set('recipeRunId', params.recipeRunId);
  const ref = await retainedRunArtifactRef(run, selectors);
  selectors.set('bundleDigest', ref.bundleDigest);
  const result = await searchArtifactText(params.paths, params.query, async (file) => {
    const selected = new URLSearchParams(selectors);
    if (params.versions?.[file]) selected.set('v', params.versions[file]);
    const { entry } = await resolveRetainedRunArtifact(run, file, selected);
    return {
      bytes: entry.bytes,
      sha256: entry.sha256,
      read: async () => {
        const handle = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const buffer = Buffer.alloc(entry.bytes + 1);
          let count = 0;
          while (count < buffer.length) {
            const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
            if (!bytesRead) break;
            count += bytesRead;
          }
          const bytes = buffer.subarray(0, count);
          if (
            count !== entry.bytes ||
            createHash('sha256').update(bytes).digest('hex') !== entry.sha256
          )
            throw new Error('Retained artifact changed.');
          return bytes.toString('utf8');
        } finally {
          await handle.close();
        }
      },
    };
  });
  return { ...result, runId: run.id, bundleDigest: ref.bundleDigest };
}
