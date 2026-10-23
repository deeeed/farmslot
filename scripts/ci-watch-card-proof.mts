/** Manual, isolated RPC/UI proof. No live farm, provider, worker or review is started. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

const [stateFile, portArg = '18797'] = process.argv.slice(2);
assert(stateFile, 'Pass a private proof state file and optional port');
const code = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-watch-card-proof-'));
for (const key of Object.keys(process.env))
  if (/^(?:FARMSLOT_|GATEWAY_|TMUX)/u.test(key)) delete process.env[key];
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'local-admin',
  NODE_TEST_CONTEXT: '1',
  GATEWAY_HOST: '127.0.0.1',
});
for (const directory of ['home', 'pool', 'projects/progress-proof', 'projects/total-proof', 'runs'])
  await fs.mkdir(path.join(root, directory), { recursive: true });
for (const name of [
  'scripts',
  'services',
  'packages',
  'schemas',
  'node_modules',
  'CLAUDE.md',
  'package.json',
])
  await fs.symlink(path.join(code, name), path.join(root, name));
const write = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value, null, 2));
await write(path.join(root, 'pool/local.json'), {
  machine: os.hostname(),
  host: 'localhost',
  slots: [],
});
await write(path.join(root, '.farm-status.json'), {
  checkedAt: new Date().toISOString(),
  slots: [],
});
for (const project of ['progress-proof', 'total-proof'])
  await write(path.join(root, 'projects', project, 'project.json'), {
    name: project,
    repo_url: 'https://github.com/example/repository.git',
    default_branch: 'main',
    ci_watch: {
      poll_interval_s: 180,
      max_hold_min: 47,
      max_total_hold_min: project === 'total-proof' ? 12 : 360,
    },
  });
await import('../services/gateway/src/runtime/mock-pty.test-support.js');
const checks = Array.from({ length: 29 }, (_, index) => ({
  name: index === 23 ? 'run-security-scan' : `check-${index + 1}`,
  status: index < 23 ? 'pass' : index === 23 ? 'fail' : 'pending',
}));
// The fixture models a previously handled standing failure. Only the monitor's
// genuine polling/deadline/output path runs; launching a fix is forbidden.
mock.module('../services/gateway/src/ci-monitor/inline-fix.js', {
  namedExports: {
    ...Object.fromEntries(
      [
        'inlineFixRunnerStillBusy',
        'resolveCiFixRetainedSession',
        'resolveCiFixReplacementOwner',
        'resolveRecoverableCiFixContext',
        'recoveredCiFixHasDeliveryProof',
        'ciFixAttemptPrompt',
        'ciFixPromptForRecovery',
        'sendCiFixNudge',
        'ciFixHasUnconfirmedPromptSend',
        'resolveCiFixTemplatePath',
      ].map((name) => [
        name,
        () => {
          throw new Error('Unsupported proof operation: ' + name);
        },
      ]),
    ),
    getSlotHeadSha: async () => null,
    isInlineFixDedupedNow: async () => true,
    tryInlineCIFix: async () => {
      throw new Error('Proof must not start a worker');
    },
    rerunFailedChecks: async () => {
      throw new Error('Proof must not rerun checks');
    },
  },
});
const realPR = await import('../services/gateway/src/methods/pr.js');
mock.module('../services/gateway/src/methods/pr.js', {
  namedExports: {
    ...realPR,
    prStatus: async () => ({
      pr: {
        prState: 'OPEN',
        merged: false,
        mergeConflict: false,
        checks,
        checkSummary: { passed: 23, failed: 1, pending: 5, skipped: 0, total: 29 },
        allPassed: false,
        anyFailed: true,
        failedNames: ['run-security-scan'],
        actionableBotComments: [],
        recommendation: 'NEEDS_ATTENTION',
      },
    }),
    computePRRecommendation: () => 'NEEDS_ATTENTION',
  },
});
const { createRun, getRun, updateRun, persistRunNow } =
  await import('../services/gateway/src/runs/store.js');
const { monitorCI, initCIMonitor, resolveCIDecision } =
  await import('../services/gateway/src/ci-monitor/service.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } =
  await import('../services/gateway/src/security/auth.js');
const { createWebSocketServer, broadcastEvent } = await import('../services/gateway/src/server.js');
initCIMonitor(broadcastEvent);
const controllers: AbortController[] = [];
const monitors: Promise<unknown>[] = [];
const runs: string[] = [];
for (const project of ['progress-proof', 'total-proof']) {
  const run = createRun({
    flowType: 'dev',
    project,
    ticketOrPr: project === 'progress-proof' ? 'CI-1' : 'CI-2',
    mode: 'interactive',
  });
  const at = new Date().toISOString();
  updateRun(run.id, {
    status: 'ci-watching',
    prNumber: 1,
    summary:
      project === 'progress-proof'
        ? 'No-progress window expires first'
        : 'Total window expires first',
    steps: run.steps.map((step) => ({
      ...step,
      status: step.name === 'ci-watch' ? 'running' : 'done',
      startedAt: at,
    })),
  });
  const controller = new AbortController();
  controllers.push(controller);
  monitors.push(monitorCI(run.id, 1, 'example/repository', controller.signal));
  runs.push(run.id);
}
// Setup-time output fixtures exercise the shared worker-state rule through RPC.
// They do not launch or claim to have launched a worker.
for (const fixing of [false, true]) {
  const run = createRun({
    flowType: 'dev',
    project: 'progress-proof',
    ticketOrPr: fixing ? 'CI-4' : 'CI-3',
    mode: 'interactive',
  });
  updateRun(run.id, {
    status: 'ci-watching',
    summary: fixing ? 'Worker fix explicitly active' : 'Phase without active worker flag',
    steps: run.steps.map((step) => ({
      ...step,
      status: step.name === 'ci-watch' ? 'running' : 'done',
      outputs:
        step.name === 'ci-watch'
          ? {
              phase: 'fixing',
              fixInProgress: fixing,
              checkSummary: { passed: 23, failed: 1, pending: 5, skipped: 0, total: 29 },
              failedNames: ['run-security-scan'],
              nextPollAt: new Date(Date.now() + 180_000).toISOString(),
              progressTimeoutAt: new Date(Date.now() + 47 * 60_000).toISOString(),
              totalTimeoutAt: new Date(Date.now() + 360 * 60_000).toISOString(),
            }
          : undefined,
    })),
  });
  runs.push(run.id);
}
const auth = createGatewayAuthRuntime();
initializeGatewayIdentity(auth, { host: '127.0.0.1' });
const principal = auth.writer.createPrincipal({ type: 'service', displayName: 'CI card proof' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const issued = auth.writer.issueCredential(principal.id, 'CI card proof');
const profileFile = path.join(root, 'profile.json');
await write(profileFile, {
  id: 'ci-card-proof',
  name: 'CI card proof',
  kind: 'custom',
  url: `ws://127.0.0.1:${portArg}`,
  authMode: 'token',
  presetSecret: issued.secret,
});
await fs.chmod(profileFile, 0o600);
const profilesFile = path.join(root, 'home', 'gateways.json');
await write(profilesFile, {
  gateways: {
    'ci-card-proof': { url: `ws://127.0.0.1:${portArg}`, authMode: 'token', secret: issued.secret },
  },
});
await fs.chmod(profilesFile, 0o600);
const http = createServer((_request, response) => {
  response.writeHead(404);
  response.end();
});
const sockets = createWebSocketServer(http, auth);
http.listen(Number(portArg), '127.0.0.1');
await once(http, 'listening');
await write(stateFile, { root, pid: process.pid, gatewayPort: Number(portArg), runs, profileFile });
console.log(
  JSON.stringify({ ready: true, root, runs, gatewayPort: Number(portArg), isolated: true }),
);
await new Promise<void>((resolve) => {
  process.once('SIGTERM', resolve);
  process.once('SIGINT', resolve);
});
for (const controller of controllers) controller.abort();
for (const id of runs)
  for (const decision of getRun(id)?.decisions ?? [])
    if (!decision.resolvedAt) resolveCIDecision(decision.id, 'abort');
await Promise.all(monitors);
for (const id of runs) {
  assert(getRun(id));
  await persistRunNow(getRun(id)!);
}
for (const client of sockets.clients) client.terminate();
sockets.close();
http.close();
