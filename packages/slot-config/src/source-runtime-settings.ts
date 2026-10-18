import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isRecord, parseProjectVisualClaimReviewPolicy } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { readWorkspaceState, resolveWorkspaceRoot } from './repo-root.js';
import { projectSourceContext } from './source-binding.js';

export type SourceRuntimeSettings = Partial<
  Record<'backlog' | 'auto_recovery' | 'visual_claim_review', unknown>
>;

function settingsPath(project: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(project))
    throw new Error('Invalid project setting target');
  return path.join(farmslotHome(), 'sources', 'runtime-settings', `${project}.json`);
}

export async function readSourceRuntimeSettings(project: string): Promise<SourceRuntimeSettings> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(settingsPath(project), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {};
  }
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    raw.project !== project ||
    !isRecord(raw.values) ||
    Object.keys(raw).some((key) => !['schemaVersion', 'project', 'values'].includes(key)) ||
    Object.keys(raw.values).some(
      (key) => !['backlog', 'auto_recovery', 'visual_claim_review'].includes(key),
    )
  )
    throw new Error('Invalid project runtime settings');
  if (raw.values.visual_claim_review !== undefined)
    raw.values.visual_claim_review = parseProjectVisualClaimReviewPolicy(
      raw.values.visual_claim_review,
    );
  return raw.values;
}

const pending = new Map<string, Promise<unknown>>();

/** Preserve mutable operator policy in a writable farm root, never in a source tree. */
export function writeSourceRuntimeSettings(
  project: string,
  values: SourceRuntimeSettings,
): Promise<string> {
  const previous = pending.get(project) ?? Promise.resolve();
  const work = previous.then(async () => {
    const normalized = { ...values };
    if ('visual_claim_review' in normalized)
      normalized.visual_claim_review = parseProjectVisualClaimReviewPolicy(
        normalized.visual_claim_review,
      );
    const destination = settingsPath(project);
    await mkdir(path.dirname(destination), { recursive: true });
    const current = await readSourceRuntimeSettings(project);
    const backup = `${destination}.bak.${randomUUID()}`;
    if (Object.keys(current).length) await copyFile(destination, backup);
    else
      await writeFile(backup, JSON.stringify({ schemaVersion: 1, project, values: current }), {
        flag: 'wx',
        mode: 0o600,
      });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ schemaVersion: 1, project, values: { ...current, ...normalized } }),
      { flag: 'wx', mode: 0o600 },
    );
    await rename(temporary, destination);
    return backup;
  });
  // The failed writer receives its error; a later valid policy change can retry.
  pending.set(
    project,
    work.then(
      () => undefined,
      () => undefined,
    ),
  );
  return work;
}

/**
 * Whether `farmslot add` copied this project in from a pack, as the install workspace's
 * state.json records. `farmslot update` replaces such a project dir on every pack sync.
 */
export function isPackCopiedProject(project: string): boolean {
  const workspace = resolveWorkspaceRoot();
  const state = workspace
    ? readWorkspaceState<{ schema_version: number; packs?: unknown }>(workspace)
    : null;
  const packs = state && isRecord(state.packs) ? Object.values(state.packs) : [];
  return packs.some(
    (pack) => isRecord(pack) && Array.isArray(pack.projects) && pack.projects.includes(project),
  );
}

/**
 * Whether a project's mutable operator policy lives in runtime settings rather than its
 * project.json: a source-bound project's tree is read-only, and a pack-copied project's dir is
 * replaced by the next pack sync.
 */
export async function usesRuntimeSettings(project: string): Promise<boolean> {
  return Boolean(await projectSourceContext(project)) || isPackCopiedProject(project);
}
