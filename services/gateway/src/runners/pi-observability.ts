import { primaryRoleForFlow, type Run } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';

import { claudeHookObservability } from './claude-observability.js';
import { runnerObservabilityDirForSlot } from './observability-files.js';
import type { RunnerObservability } from './observability-types.js';
import { runnerSessionIdForPath } from './session-path-resolution.js';
import { resolveRunRetainedSessionBinding } from './session-process.js';
import { contextPaneId } from './session-record.js';
import type { RecoveredUsageSession } from './session-usage-provider.js';

interface PiSessionScope {
  homeRoot?: string;
  observabilityDir?: string;
  paneId?: string;
  slotId?: string;
  startedAt?: number;
  endedAt?: number;
  reviewerIntervals?: Array<{ startedAt: number; endedAt: number }>;
}

/** Read only Pi-owned session headers and, for recovery, the exact pane/session snapshot. */
export function buildPiSessionDiscoveryCommand(repo: string, scope: PiSessionScope = {}): string {
  return `python3 - <<'PY'
import datetime, json, os
from pathlib import Path
from urllib.parse import quote
repo = ${JSON.stringify(repo)}
scope = json.loads(${JSON.stringify(JSON.stringify(scope))})
home = Path(scope.get('homeRoot') or str(Path.home()))
paths = []
for file in (home / '.pi' / 'agent' / 'sessions').glob('*/*.jsonl'):
    try:
        with file.open() as stream:
            header = json.loads(stream.readline())
        if header.get('type') != 'session' or os.path.realpath(header.get('cwd', '')) != os.path.realpath(repo):
            continue
        if scope.get('observabilityDir'):
            started = datetime.datetime.fromisoformat(header['timestamp'].replace('Z', '+00:00')).timestamp() * 1000
            if started < scope['startedAt'] or started >= scope['endedAt']:
                continue
            if any(interval['startedAt'] <= started < interval['endedAt'] for interval in scope.get('reviewerIntervals', [])):
                continue
            session = file.stem
            snapshot = json.loads((Path(scope['observabilityDir']) / 'sessions' / (quote(session, safe='') + '.json')).read_text())
            if snapshot.get('session_id') != session or snapshot.get('runner') != 'pi' or snapshot.get('tmuxPane') != scope['paneId'] or snapshot.get('slotId') != scope['slotId']:
                continue
            if os.path.realpath(snapshot.get('cwd', '')) != os.path.realpath(repo):
                continue
        paths.append(os.path.realpath(file))
    except (OSError, ValueError, TypeError, KeyError):
        # Partial or unavailable runner-owned metadata cannot establish a binding.
        continue
print(json.dumps(sorted(paths)))
PY`;
}

export function createPiHookObservability(): RunnerObservability {
  return {
    ...claudeHookObservability,
    async listSessionFiles(vars) {
      const result = await execOnSlot(vars, buildPiSessionDiscoveryCommand(vars.remoteRepo), {
        timeout: 10_000,
        selectNodeSupport: false,
      });
      if (result.exitCode !== 0) throw new Error('Pi session discovery failed');
      return JSON.parse(result.stdout) as string[];
    },
  };
}

/** A reused fix context can own several Pi sessions. Reviewers never enter its rollup. */
export async function recoverPiUsageSessions(run: Run): Promise<RecoveredUsageSession[]> {
  if (!run.slotId) return [];
  const primaryRole = primaryRoleForFlow(run.flowType);
  const contexts = run.agentContexts ?? [];
  const runEnd = Math.min(Date.now(), Date.parse(run.completedAt ?? '') || Infinity);
  const reviewerIntervals = contexts
    .filter((context) => context.role === 'review' && primaryRole !== 'review')
    .map((context) => ({
      startedAt: Date.parse(context.startedAt ?? ''),
      endedAt: Date.parse(context.completedAt ?? '') || runEnd,
    }))
    .filter((interval) => Number.isFinite(interval.startedAt));
  const sessions = new Map<string, RecoveredUsageSession>();
  const vars = await loadSlotVars(run.slotId);
  for (const context of contexts) {
    if (context.runner !== 'pi' || ![primaryRole, 'review-fix', 'ci-fix'].includes(context.role))
      continue;
    const retained = resolveRunRetainedSessionBinding(run, context);
    if (retained.binding) {
      sessions.set(retained.binding.runnerSessionPath, {
        contextId: context.id,
        ...retained.binding,
      });
    }
    const paneId = context.target && contextPaneId(context.target);
    const startedAt = Date.parse(context.startedAt ?? '');
    if (retained.incompleteBinding || !paneId || !Number.isFinite(startedAt)) continue;
    const endedAt = Math.min(runEnd, Date.parse(context.completedAt ?? '') || Infinity);
    const result = await execOnSlot(
      vars,
      buildPiSessionDiscoveryCommand(vars.remoteRepo, {
        observabilityDir: await runnerObservabilityDirForSlot(vars),
        paneId,
        slotId: run.slotId,
        startedAt,
        endedAt,
        reviewerIntervals,
      }),
      { timeout: 10_000, selectNodeSupport: false },
    );
    if (result.exitCode !== 0) throw new Error('Pi usage session recovery failed');
    const paths: string[] = JSON.parse(result.stdout);
    for (const runnerSessionPath of paths) {
      sessions.set(runnerSessionPath, {
        contextId: context.id,
        runnerSessionId: runnerSessionIdForPath(runnerSessionPath),
        runnerSessionPath,
      });
    }
  }
  return [...sessions.values()];
}
