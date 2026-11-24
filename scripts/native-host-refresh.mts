// Controlled native-host refresh: docs/operations/native-host-refresh.md.
//   node --import tsx scripts/native-host-refresh.mts --root <native state dir> [--machine <id>]
//     lists the host's runtime and its live sessions.
//   ... --refresh            retires the host only if all its runners have stopped.
//   ... --refresh --stop-idle also stops idle live sessions (journals kept, resumable).
// It never starts a host: the next launch from the gateway or node starts the current runtime.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { NativeSessionClient } = await import('../packages/agent-runtime/src/native/client.js');
const { nativeHostRunsCurrentRuntime } =
  await import('../packages/agent-runtime/src/native/host-runtime.js');
const { RUNTIME_VERSION } = await import('../packages/agent-runtime/src/version.js');

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    machine: { type: 'string' },
    refresh: { type: 'boolean', default: false },
    'stop-idle': { type: 'boolean', default: false },
  },
});
if (!values.root) throw new Error('--root <native state dir> is required');
const machine = values.machine ?? 'local';
const root = path.resolve(
  machine === 'local' ? values.root : path.join(values.root, 'nodes', encodeURIComponent(machine)),
);
const hostFile = path.join(root, 'host.json');
const client = new NativeSessionClient(root, machine);
let live;
try {
  live = existsSync(hostFile) ? await client.liveSessions() : undefined;
} catch (error) {
  // A recorded host that no longer runs (retired or stopped) is the same as none.
  if (!(error instanceof Error && 'code' in error && error.code === 'NATIVE_SOURCE_UNAVAILABLE'))
    throw error;
}
if (!live) {
  console.log(`No host running at ${root}; the next launch starts runtime ${RUNTIME_VERSION}.`);
  process.exit(0);
}
const host = JSON.parse(readFileSync(hostFile, 'utf8'));
console.log(
  `Host pid ${host.pid}: runtime ${host.runtimeVersion ?? 'unknown (legacy)'}, ` +
    `build ${String(host.runtimeBuild ?? 'unknown').slice(0, 12)}; this checkout runs ${RUNTIME_VERSION}.` +
    (nativeHostRunsCurrentRuntime(host) ? ' It is current.' : ' It needs a refresh.'),
);
for (const session of live)
  console.log(
    `  live ${session.id} ${session.state} ${session.runner} owner=${session.ownerPrincipalId} cwd=${session.cwd}`,
  );
if (!values.refresh || nativeHostRunsCurrentRuntime(host)) process.exit(0);
// --stop-idle keeps no session, so idle runners are stopped with the host; busy ones still hold it.
if (values['stop-idle']) client.setRefreshPolicy(async () => new Map<string, string>());
const { refreshed, busy } = await client.refreshStaleHost();
if (refreshed) console.log('Retired. The next gateway or node launch starts the current runtime.');
else {
  console.log(
    busy.length
      ? `Not refreshed; busy: ${busy.join('; ')}`
      : values['stop-idle']
        ? 'Not refreshed.'
        : 'Not refreshed: live runners remain. Add --stop-idle to stop idle ones.',
  );
  process.exitCode = 1;
}
