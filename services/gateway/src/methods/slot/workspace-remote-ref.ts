import { currentProjectSources } from '@farmslot/slot-config';

import type { SlotVars } from '../../core/config.js';
import { currentSlotCommandExecutor } from '../../core/exec-scope.js';
import { withFarmGitConfig } from '../../core/farm-git.js';
import { readSlotProbe } from '../../core/read-probes.js';
import { shellQuote } from '../../core/tmux.js';
import { getNode } from '../../fleet/machine-registry.js';

interface RemoteRefObservation {
  sha: string | null;
  observedAt: string;
}

interface RemoteRefQuery {
  vars: SlotVars;
  /** Hash of the resolved remote URL and effective Git authentication configuration. */
  remoteKey: string;
  remote: string;
  ref: string;
  scope: string;
  timeoutMs: number;
  passive: boolean;
}

interface CachedRef {
  until: number;
  pending: boolean;
  promise: Promise<RemoteRefObservation>;
}
const refs = new Map<string, CachedRef>();
const connections = new WeakMap<object, number>();
let nextConnection = 0;
const PASSIVE_REF_TTL_MS = 60_000;

/** Passive default/publication readers share one answer; acting and owned reads stay fresh. */
export function readWorkspaceRemoteRef(query: RemoteRefQuery): Promise<RemoteRefObservation> {
  const { vars, remote, ref, scope, timeoutMs } = query;
  const read = () =>
    readSlotProbe(
      vars,
      withFarmGitConfig(
        `git -C ${shellQuote(vars.remoteRepo)} ls-remote --heads ${shellQuote(remote)} ${shellQuote(ref)}`,
      ),
      scope,
      timeoutMs,
      '/',
    ).then((result) => ({
      sha: result.stdout.trim().split(/\s+/)[0] || null,
      observedAt: new Date().toISOString(),
    }));
  if (!query.passive || currentSlotCommandExecutor() || currentProjectSources()) return read();

  const node = getNode(vars.machine);
  if (node && !connections.has(node.ws)) connections.set(node.ws, ++nextConnection);
  const key = JSON.stringify([
    vars.machine,
    vars.host,
    vars.sshTarget,
    node && connections.get(node.ws),
    query.remoteKey,
    ref,
  ]);
  const cached = refs.get(key);
  if (cached && (cached.pending || cached.until > Date.now())) return cached.promise;
  const entry: CachedRef = {
    until: 0,
    pending: true,
    promise: read()
      .then((value) => {
        entry.pending = false;
        entry.until = Date.now() + PASSIVE_REF_TTL_MS;
        return value;
      })
      .catch((error: unknown) => {
        if (refs.get(key) === entry) refs.delete(key);
        throw error;
      }),
  };
  // A fleet has a bounded inventory; don't retain old remote/ref identities after it changes.
  if (refs.size >= 512) refs.delete(refs.keys().next().value!);
  refs.set(key, entry);
  return entry.promise;
}
