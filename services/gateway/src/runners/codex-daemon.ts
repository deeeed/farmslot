import path from 'node:path';

import { parse as parseShell } from 'shell-quote';

import { runnerRuntimeDir } from '../../../../scripts/lib/runner-runtime.cjs';
import { resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot, type SlotVars } from '../core/index.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';
import { parseProcessCensus } from '../run-lifecycle/process-census.js';
import { reapIdentifiedSlotProcesses } from '../run-lifecycle/process-reap.js';

import type { RunnerSlotRuntimeCleanupOptions } from './registry.js';

/** A worker's managed daemon and updater survive /exit outside the pane tree. */
export async function cleanupCodexSlotRuntime(
  vars: SlotVars,
  opts: RunnerSlotRuntimeCleanupOptions,
): Promise<string | null> {
  const home = path.posix.join(
    runnerRuntimeDir(vars.remoteRepo, await resolveProjectRuntimeDir(vars.projectName)),
    'codex-home',
  );
  const census = await execOnSlot(
    vars,
    `: farmslot-runner-daemon-census\npython3 - ${shellExpressionForRemotePath(home)} <<'PY'
import json, pathlib, subprocess, sys
home = pathlib.Path(sys.argv[1])
records = []
for name in ('daemon.pid', 'daemon-updater.pid', 'app-server.pid', 'app-server-updater.pid'):
    file = home / 'app-server-daemon' / name
    try:
        record = json.loads(file.read_text())
    except FileNotFoundError:
        continue
    if not isinstance(record, dict) or type(record.get('pid')) is not int or record['pid'] <= 1 or not isinstance(record.get('processStartTime'), str):
        raise ValueError('Invalid managed runner process record')
    records.append({'pid': record['pid'], 'start': record['processStartTime'], 'updater': 'updater' in name})
if records:
    result = subprocess.run(['ps', '-axo', 'pid=,ppid=,pgid=,lstart=,args='], text=True, capture_output=True, check=True)
    print(result.stdout, end='')
print('--records--')
print(json.dumps({'home': str(home.resolve()), 'records': records}))
PY`,
    { cwd: '/', timeout: 15_000 },
  );
  if (census.exitCode !== 0) return 'Managed runner daemon census failed; slot cleanup deferred';
  const [table, json] = census.stdout.split(/^--records--\n/m);
  if (json === undefined)
    return 'Managed runner daemon census is unavailable; slot cleanup deferred';
  const resultData: unknown = JSON.parse(json);
  if (
    typeof resultData !== 'object' ||
    resultData === null ||
    !('home' in resultData) ||
    typeof resultData.home !== 'string' ||
    !('records' in resultData) ||
    !Array.isArray(resultData.records)
  )
    throw new Error('Invalid managed runner daemon census');
  const { home: realHome, records } = resultData;
  const rows = parseProcessCensus(table);
  const roots = rows.filter((row) => {
    if (row.parent !== '1') return false;
    const args = parseShell(row.command);
    const executable = args[0];
    if (
      typeof executable !== 'string' ||
      !['app-server-daemon', 'standalone'].some((pkg) =>
        executable.startsWith(`${realHome}/packages/${pkg}/releases/`),
      ) ||
      path.posix.basename(executable) !== 'codex' ||
      args[1] !== 'app-server'
    )
      return false;
    return records.some(
      (record: unknown) =>
        typeof record === 'object' &&
        record !== null &&
        'pid' in record &&
        String(record.pid) === row.pid &&
        'start' in record &&
        typeof record.start === 'string' &&
        record.start.replace(/\s+/g, ' ').trim() === row.identity &&
        'updater' in record &&
        (record.updater === true
          ? args[2] === 'daemon' && args[3] === 'pid-update-loop'
          : record.updater === false && args.includes('--managed-daemon')),
    );
  });
  const result = await reapIdentifiedSlotProcesses(vars, rows, roots, opts);
  if (!result) return null;
  console.log(
    `[runner-cleanup] ${vars.slotId}: stopped ${result.total - result.survivors.length} managed daemon process(es)`,
  );
  return result.survivors.length
    ? `Managed runner daemon process(es) ${result.survivors.map((row) => row.pid).join(', ')} did not stop`
    : null;
}
