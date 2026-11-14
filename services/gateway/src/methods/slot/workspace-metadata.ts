import { DEFAULT_BRANCH, type SlotStatus } from '@farmslot/protocol';
import { isRecord } from '@farmslot/protocol/recipe';
import { currentProjectSources } from '@farmslot/slot-config';

import { currentSlotCommandExecutor } from '../../core/exec-scope.js';
import {
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  slotFilesReadInProcess,
  type SlotVars,
} from '../../core/index.js';
import { readSlotProbe } from '../../core/read-probes.js';
import { type ConnectedNode, getNode } from '../../fleet/machine-registry.js';

import type { WorkspaceMetadataVersion } from './workspace-metadata-policy.js';
import {
  workspaceMetadataCommand,
  type WorkspaceMetadataRoot,
} from './workspace-metadata-program.js';
import { localWorkspaceVersion } from './workspace-version.js';

interface MetadataQuery {
  vars: SlotVars;
  root: WorkspaceMetadataRoot;
  previous?: WorkspaceMetadataVersion;
}
interface MetadataBatch {
  key: string;
  connection: ConnectedNode['ws'];
  until: number;
  pending: boolean;
  promise: Promise<Map<string, WorkspaceMetadataVersion>>;
}
const batches = new Map<string, MetadataBatch>();
const INTERVAL_MS = 15_000;

async function remoteVersions(
  queries: MetadataQuery[],
): Promise<Map<string, WorkspaceMetadataVersion>> {
  const first = queries[0];
  if (!first) return new Map();
  const connection = getNode(first.vars.machine)?.ws;
  if (!connection) return new Map();
  queries.sort((a, b) => a.root.slotId.localeCompare(b.root.slotId));
  const roots = queries.map((query) => ({
    ...query.root,
    ...(query.previous ? { previous: query.previous } : {}),
  }));
  const key = JSON.stringify(queries.map(({ vars, root }) => [vars.host, root]));
  const cached = batches.get(first.vars.machine);
  if (
    cached?.key === key &&
    cached.connection === connection &&
    (cached.pending || cached.until > Date.now())
  )
    return cached.promise;
  const entry: MetadataBatch = {
    key,
    connection,
    until: Date.now() + INTERVAL_MS,
    pending: true,
    promise: Promise.resolve()
      .then(async () => {
        const result = await readSlotProbe(
          first.vars,
          workspaceMetadataCommand(roots),
          'workspace-metadata',
          5000,
          '/',
        );
        // A replaced node must not attest the new connection's workspace metadata.
        if (getNode(first.vars.machine)?.ws !== connection) return new Map();
        const rows: unknown = JSON.parse(result.stdout);
        const ids = new Set(roots.map((root) => root.slotId));
        const versions = new Map<string, WorkspaceMetadataVersion>();
        if (!Array.isArray(rows) || rows.length !== ids.size)
          throw new Error('Invalid workspace metadata batch');
        for (const row of rows) {
          if (
            !isRecord(row) ||
            typeof row.slotId !== 'string' ||
            !ids.delete(row.slotId) ||
            (row.version !== null && typeof row.version !== 'string') ||
            typeof row.ancestryCacheable !== 'boolean'
          )
            throw new Error('Invalid workspace metadata row');
          if (typeof row.version === 'string')
            versions.set(row.slotId, {
              version: row.version,
              ancestryCacheable: row.ancestryCacheable,
            });
        }
        return versions;
      })
      .catch(() => {
        // Metadata is an optimization. No version forces the authoritative full inspection,
        // including its existing errors and unavailable retry policy, rather than stale reuse.
        return new Map<string, WorkspaceMetadataVersion>();
      })
      .finally(() => {
        entry.pending = false;
        entry.until = Date.now() + INTERVAL_MS;
      }),
  };
  batches.set(first.vars.machine, entry);
  return entry.promise;
}

/** All passive roots share one metadata command per remote node per interval. */
export async function passiveWorkspaceVersions(
  slots: readonly SlotStatus[],
  previous: ReadonlyMap<string, WorkspaceMetadataVersion> = new Map(),
): Promise<Map<string, WorkspaceMetadataVersion>> {
  // A scoped owner/source must never join a machine-wide read or cache.
  if (currentSlotCommandExecutor() || currentProjectSources()) return new Map();
  const queries = await Promise.all(
    slots.map(async (slot): Promise<MetadataQuery | undefined> => {
      try {
        const vars = await loadSlotVars(slot.slot);
        const project = await loadProjectVars(vars.projectName);
        const defaultBranch =
          getProjectField(project.projectJson, 'default_branch') || DEFAULT_BRANCH;
        return {
          vars,
          previous: previous.get(slot.slot),
          root: { slotId: slot.slot, machine: vars.machine, repo: vars.remoteRepo, defaultBranch },
        };
      } catch {
        // Unreadable configuration cannot justify reuse; the normal inspection owns its error.
        return undefined;
      }
    }),
  );
  const versions = new Map<string, WorkspaceMetadataVersion>();
  const remote = new Map<string, MetadataQuery[]>();
  await Promise.all(
    queries.map(async (query) => {
      if (!query) return;
      if (slotFilesReadInProcess(query.vars)) {
        try {
          const version = await localWorkspaceVersion(
            query.vars,
            query.root.defaultBranch,
            query.previous,
          );
          if (version !== undefined) versions.set(query.root.slotId, version);
        } catch {
          // An unreadable local checkout follows the same authoritative fallback as a remote one.
          return;
        }
      } else {
        const group = remote.get(query.vars.machine) ?? [];
        group.push(query);
        remote.set(query.vars.machine, group);
      }
    }),
  );
  await Promise.all(
    [...remote.values()].map(async (group) => {
      for (const [slotId, version] of await remoteVersions(group)) versions.set(slotId, version);
    }),
  );
  return versions;
}
