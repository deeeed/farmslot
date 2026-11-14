// Manual proof: real Pi, a loopback provider, private tmux and production gateway RPC.
// TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx --test scripts/runner-validation/pi-reasoning-receipt.live.mts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AgentContext, NativeSessionInfo, RunGetResult } from '@farmslot/protocol';
import { createNativeProofFixture } from '../../services/gateway/src/runtime/native-proof-fixture.live-support.js';

const output = process.env.FARMSLOT_PI_REASONING_EVIDENCE;
const browserHold = process.env.FARMSLOT_PI_REASONING_BROWSER === '1';
const source = fileURLToPath(new URL('../../', import.meta.url));
const cli =
  process.env.FARMSLOT_PI_PROOF_CLI ??
  path.join(
    os.homedir(),
    '.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
  );
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(
  label: string,
  read: () => Promise<T | undefined>,
  budgetMs = 30_000,
): Promise<T> {
  const end = Date.now() + budgetMs;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    assert.ok(Date.now() < end, label);
    await pause(100);
  }
}

test(
  'real Pi request receipts reach run.get and the shared label for both transports',
  { timeout: browserHold ? 420_000 : 180_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-reasoning-rpc-')));
    const socket = await mkdtemp('/tmp/pir-');
    Object.assign(process.env, {
      NODE_TEST_CONTEXT: '1',
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: path.join(root, 'home'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
      FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      TMUX_TMPDIR: socket,
    });
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8' }).trim();
    const wire: Array<Record<string, unknown>> = [];
    const provider = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models')
        return res.end(
          JSON.stringify({
            data: [
              {
                id: 'synthetic-model',
                reasoning: true,
                context_length: 32768,
                max_output_tokens: 1024,
              },
            ],
          }),
        );
      if (req.url === '/v1/model/info') return res.end(JSON.stringify({ data: [] }));
      assert.equal(req.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      wire.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('content-type', 'text/event-stream');
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null) => ({
        id: 'local-proof',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'synthetic-model',
        choices: [{ index: 0, delta, finish_reason }],
      });
      res.write(
        'data: ' +
          JSON.stringify(chunk({ role: 'assistant', content: 'Receipt proof complete.' }, null)) +
          '\n\n',
      );
      res.write('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
    let ownsTmux = false;
    t.after(async () => {
      if (ownsTmux) tmux('kill-server');
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(socket, { recursive: true, force: true });
    });
    for (const name of [
      'scripts',
      'packages',
      'services',
      'node_modules',
      'schemas',
      'package.json',
      'CLAUDE.md',
    ])
      await symlink(path.join(source, name), path.join(root, name));
    const repo = path.join(root, 'checkout');
    for (const name of [
      'home',
      'pool',
      'projects/fixture',
      'checkout/.agent/.observability',
      'agent',
    ])
      await mkdir(path.join(root, name), { recursive: true });
    await writeFile(
      path.join(root, 'agent/settings.json'),
      JSON.stringify({ packages: [], skills: [] }),
    );
    await writeFile(
      path.join(root, 'projects/fixture/project.json'),
      JSON.stringify({ name: 'fixture', paths: { runtime_dir: '.agent' } }),
    );
    await writeFile(
      path.join(root, 'pool/local.json'),
      JSON.stringify({
        machine: 'local',
        host: 'localhost',
        ssh_user: os.userInfo().username,
        project: 'fixture',
        platform: 'cli',
        slots: [
          { id: 'receipt-slot', enabled: true, repo, session: 'receipt-proof', resources: {} },
        ],
      }),
    );
    await writeFile(
      path.join(root, 'status.json'),
      JSON.stringify({
        slots: [
          {
            slot: 'receipt-slot',
            machine: 'local',
            project: 'fixture',
            repo,
            session: 'receipt-proof',
            lifecycle: 'ready',
            enabled: true,
            agent: 'idle',
          },
        ],
      }),
    );
    for (const name of Object.keys(process.env))
      if (/TOKEN|API_KEY|PASSWORD|AUTH_TOKEN|FARMSLOT_PI_|ANTHROPIC_|OPENAI_|LITELLM_/u.test(name))
        delete process.env[name];
    const managed: Array<{ info: NativeSessionInfo; leaseId: string }> = [];
    const { nativeSessionManager } =
      await import('../../services/gateway/src/runners/native/manager.js');
    let owner = '';
    t.after(async () => {
      for (const { info, leaseId } of managed)
        await nativeSessionManager.closeWorker(owner, {
          sessionId: info.id,
          executionNodeId: 'local',
          generation: info.generation,
          leaseId,
        });
    });
    const fixture = await createNativeProofFixture(t, root);
    owner = fixture.person.id;
    const connection = await fixture.client.connect();
    t.after(() => connection.close());
    const store = await import('../../services/gateway/src/runs/store.js');
    const { loadSlotVars } = await import('../../services/gateway/src/core/config.js');
    const { checkAgentLive } = await import('../../services/gateway/src/run-engine/run-monitor.js');
    const { readNativeWorkerSnapshot } =
      await import('../../services/gateway/src/runners/native/worker-control.js');
    const { captureRunnerSessionMetadata } =
      await import('../../services/gateway/src/runners/session-process.js');
    const { recordRunnerSessionForRole } =
      await import('../../services/gateway/src/runners/session-record.js');
    const { runEngineLabel, runWorkerEffort } =
      await import('../../packages/protocol/src/index.js');
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'receipt-proof', '-c', repo, '/bin/sh');
    ownsTmux = true;
    Object.assign(process.env, {
      PI_CODING_AGENT_DIR: path.join(root, 'agent'),
      FARMSLOT_PI_OLLAMA: '0',
      LITELLM_URL: 'http://127.0.0.1:' + address.port + '/v1',
      LITELLM_API_KEY: 'loopback-proof-only',
    });
    const vars = await loadSlotVars('receipt-slot');
    const results: unknown[] = [];
    for (const transport of ['tmux', 'native'] as const)
      for (const effort of ['off', 'medium']) {
        const environment = {
          PATH: path.dirname(process.execPath) + ':/opt/homebrew/bin:/usr/bin:/bin',
          HOME: root,
          TERM: 'xterm-256color',
          PI_OFFLINE: '1',
          PI_CODING_AGENT_DIR: path.join(root, 'agent'),
          FARMSLOT_PI_OLLAMA: '0',
          LITELLM_URL: 'http://127.0.0.1:' + address.port + '/v1',
          LITELLM_API_KEY: 'loopback-proof-only',
          FARMSLOT_OBS_DIR: path.join(repo, '.agent/.observability'),
          FARMSLOT_SLOT_ID: 'receipt-slot',
          FARMSLOT_THINKING: effort,
        };
        const run = store.createRun(
          {
            project: 'fixture',
            flowType: 'dev',
            mode: 'interactive',
            ticketOrPr: 'reasoning receipt proof',
            slotId: 'receipt-slot',
            runner: 'pi',
            model: 'litellm/synthetic-model',
            effort,
            transport,
          },
          { createdByPrincipalId: owner, nativeOwnerPrincipalId: owner },
        );
        const context: AgentContext = {
          id: 'dev',
          role: 'dev',
          label: 'Receipt proof',
          status: 'working',
          slotId: 'receipt-slot',
          runId: run.id,
          runner: 'pi',
          model: 'litellm/synthetic-model',
          effort,
          attemptStartedAt: new Date().toISOString(),
        };
        const requestIndex = wire.length;
        if (transport === 'tmux') {
          const paneId = tmux('display-message', '-p', '-t', 'receipt-proof', '#{pane_id}');
          context.target = { session: 'receipt-proof', target: paneId, paneId };
          store.updateRun(run.id, { agentContexts: [context], status: 'monitoring' });
          const args = [
            'env',
            '-i',
            ...Object.entries({ ...environment, TMUX_PANE: paneId }).map(([k, v]) => k + '=' + v),
            process.execPath,
            cli,
            '--no-extensions',
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            '--no-mcp',
            '-e',
            path.join(source, 'scripts/runners/pi-farmslot-observability.ts'),
            '--model',
            context.model!,
            '--thinking',
            effort,
            'Return one short sentence.',
          ];
          tmux(
            'respawn-pane',
            '-k',
            '-t',
            paneId,
            '/bin/sh',
            '-c',
            'exec ' + args.map(quote).join(' '),
          );
          await until('Pi did not serialize its request', async () =>
            wire.length > requestIndex ? true : undefined,
          );
          const session = await captureRunnerSessionMetadata(vars, 'pi', [], {
            paneId,
            slotId: 'receipt-slot',
            sinceMs: Date.parse(context.attemptStartedAt!),
          });
          assert.ok(session.runnerSessionPath);
          await recordRunnerSessionForRole({
            runId: run.id,
            role: 'dev',
            contextId: 'dev',
            session,
            captureLabel: 'real Pi receipt proof',
            paneId,
          });
        } else {
          const executable = path.join(root, 'pi-wrapper');
          await writeFile(
            executable,
            '#!/bin/sh\nexec ' +
              [
                process.execPath,
                cli,
                '--no-extensions',
                '--no-skills',
                '--no-prompt-templates',
                '--no-themes',
                '--no-mcp',
                '-e',
                path.join(source, 'scripts/runners/pi-farmslot-observability.ts'),
              ]
                .map(quote)
                .join(' ') +
              ' "$@"\n',
          );
          await chmod(executable, 0o700);
          const leaseId = randomUUID();
          if (managed.length === 0) {
            const warm = nativeSessionManager.warm();
            const outcome = await warm.then(
              () => null,
              (error: unknown) => error,
            );
            if (outcome) {
              const { observeExistingNativeHost } =
                await import('../../packages/agent-runtime/src/native/client.js');
              await until('The single proof host startup did not become ready', async () => {
                const ready = await readFile(path.join(root, 'native/ready.json'), 'utf8').then(
                  () => true,
                  (error: NodeJS.ErrnoException) => {
                    if (error.code === 'ENOENT') return false;
                    throw error;
                  },
                );
                if (!ready) return undefined;
                await observeExistingNativeHost(() => nativeSessionManager.list(owner));
                return true;
              });
            }
          }
          const info = await nativeSessionManager.ensureWorker(
            owner,
            {
              sessionId: randomUUID(),
              runner: 'pi',
              model: context.model!,
              cwd: repo,
              executionNodeId: 'local',
            },
            {
              leaseId,
              executable,
              effort,
              environment: { set: environment, unset: [] },
              safetyTier: 'sandboxed',
            },
          );
          managed.push({ info, leaseId });
          assert.ok(info.nativeSessionPath, 'real Pi must expose its saved session file');
          const commandId = randomUUID();
          context.runnerSessionId = info.nativeSessionId;
          context.nativeSession = {
            sessionId: info.id,
            executionNodeId: 'local',
            ownerPrincipalId: owner,
            generation: info.generation,
            leaseId,
            commandId,
          };
          store.updateRun(run.id, { agentContexts: [context], status: 'monitoring' });
          await nativeSessionManager.sendWorker(
            owner,
            { sessionId: info.id, executionNodeId: 'local', generation: info.generation, leaseId },
            commandId,
            'Return one short sentence.',
          );
        }
        const observed = await until('Gateway did not persist the adapter receipt', async () => {
          if (transport === 'native') await readNativeWorkerSnapshot(run.id, 'dev', 'dev');
          else await checkAgentLive('receipt-slot', 'pi', run.id, 'dev', 'dev');
          const record = (await connection.call<RunGetResult>('run.get', { runId: run.id })).run;
          return record.agentContexts?.find((item) => item.id === 'dev')?.reasoningReceipt
            ? record
            : undefined;
        });
        const expected = effort === 'off' ? 'default' : 'medium';
        const label = runEngineLabel({
          runner: 'pi',
          model: context.model!,
          effort: runWorkerEffort(observed),
        });
        assert.equal(label, 'pi/litellm/synthetic-model · ' + expected);
        assert.equal(wire[requestIndex].reasoning_effort, effort === 'off' ? undefined : 'medium');
        assert.equal(wire.length, requestIndex + 1, 'one local request per controlled turn');
        await store.persistRunNow(store.getRun(run.id)!, 'real Pi reasoning receipt proof');
        console.log(
          JSON.stringify({
            transport,
            effort,
            label,
            wireEffort: wire[requestIndex].reasoning_effort ?? 'omitted',
          }),
        );
        results.push({
          transport,
          effort,
          wireEffort: wire[requestIndex].reasoning_effort ?? 'omitted',
          label,
          receipt: observed.agentContexts?.find((item) => item.id === 'dev')?.reasoningReceipt,
        });
      }
    if (output) {
      await mkdir(output, { recursive: true });
      await writeFile(
        path.join(output, 'real-pi-receipts.json'),
        JSON.stringify(
          { pass: true, requests: wire.length, externalRequests: 0, results },
          null,
          2,
        ),
      );
    }
    if (browserHold) {
      assert.ok(output, 'The optional browser check needs a private evidence directory');
      const { saveProfiles } = await import('../../packages/cli/src/gateway-profiles.js');
      const home = path.join(output, 'browser-home');
      await mkdir(home, { recursive: true, mode: 0o700 });
      saveProfiles(
        {
          active: 'proof',
          gateways: {
            proof: { url: fixture.url, authMode: 'token', secret: fixture.browserCredential },
          },
        },
        path.join(home, 'gateways.json'),
      );
      await writeFile(
        path.join(output, 'browser-ready.json'),
        JSON.stringify({ url: fixture.url, home }),
        { mode: 0o600 },
      );
      console.log('Waiting for the connected browser check on the isolated gateway.');
      await until(
        'The connected browser check did not finish',
        async () =>
          readFile(path.join(output, 'browser-done'), 'utf8').then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return undefined;
              throw error;
            },
          ),
        240_000,
      );
    }
    console.log(
      JSON.stringify({ pass: true, requests: wire.length, externalRequests: 0, results }),
    );
  },
);
