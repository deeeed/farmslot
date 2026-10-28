import { primaryRoleForFlow, type Run } from '@farmslot/protocol';

import { selectAgentContext } from '../agents/contexts.js';
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

/** Old Pi hooks omitted transcript_path. Recover only one session in the owning role's interval. */
export async function recoverPiUsageSession(run: Run): Promise<RecoveredUsageSession | null> {
  const context = selectAgentContext(run, { role: primaryRoleForFlow(run.flowType) });
  if (!context) return null;
  const retained = resolveRunRetainedSessionBinding(run, context);
  if (retained.binding) return { contextId: context.id, ...retained.binding };
  if (retained.incompleteBinding) return null;
  const paneId = context?.target && contextPaneId(context.target);
  const startedAt = Date.parse(context?.startedAt ?? '');
  if (!run.slotId || !context || !paneId || !Number.isFinite(startedAt)) return null;
  const endedAt = Math.min(
    Date.now(),
    ...(run.agentContexts ?? [])
      .filter((peer) => peer.id !== context.id)
      .map((peer) => Date.parse(peer.startedAt ?? ''))
      .filter((time) => time > startedAt),
  );
  const vars = await loadSlotVars(run.slotId);
  const result = await execOnSlot(
    vars,
    buildPiSessionDiscoveryCommand(vars.remoteRepo, {
      observabilityDir: await runnerObservabilityDirForSlot(vars),
      paneId,
      slotId: run.slotId,
      startedAt,
      endedAt,
    }),
    { timeout: 10_000, selectNodeSupport: false },
  );
  if (result.exitCode !== 0) throw new Error('Pi usage session recovery failed');
  const paths: string[] = JSON.parse(result.stdout);
  if (paths.length !== 1) return null;
  const runnerSessionPath = paths[0];
  const runnerSessionId = runnerSessionIdForPath(runnerSessionPath);
  return { contextId: context.id, runnerSessionId, runnerSessionPath };
}
