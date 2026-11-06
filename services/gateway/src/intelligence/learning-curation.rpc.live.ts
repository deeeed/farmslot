// Opt-in contract proof: real RPC/retained data/ledger, deterministic provider, no farm or library writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { type Context, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { WebSocket } from 'ws';

import type { RunGetResult } from '@farmslot/protocol';

test(
  'curation drops noise, exposes one eligible draft and keeps consumption human-owned',
  { timeout: 60_000 },
  async (t) => {
    assert.equal(process.env.FARMSLOT_CURATION_LIVE, '1');
    const out = process.env.FARMSLOT_CURATION_PROOF_OUT;
    assert(out);
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const root = await mkdtemp(path.join(os.tmpdir(), 'learning-curation-rpc-'));
    Object.assign(process.env, {
      NODE_TEST_CONTEXT: '1',
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: root,
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
      OPENAI_API_KEY: 'isolated-faux-provider',
    });
    let shutdown = async () => {};
    t.after(async () => {
      try {
        await shutdown();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    await mkdir(out, { recursive: true });
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
    await mkdir(path.join(root, 'pool'));
    const project = path.join(root, 'projects/curation');
    const library = path.join(project, 'library/review');
    await mkdir(library, { recursive: true });
    const rule = '# Existing rule\nUse the provider-owned market id.';
    await writeFile(path.join(library, 'antipatterns.md'), rule);
    await writeFile(
      path.join(project, 'project.json'),
      JSON.stringify({
        name: 'curation',
        static_review: {
          support: { libraries: [{ name: 'team', root: { projectPath: 'library' } }] },
        },
        reference_repos: { team_library: { repo_url: 'git@github.com:example/knowledge.git' } },
      }),
    );
    await writeFile(
      path.join(root, 'llm-config.json'),
      JSON.stringify({
        defaultProvider: 'openai',
        intelligenceModel: 'curation-fixture',
        improvementModel: 'curation-fixture',
      }),
    );
    await import('../runtime/mock-pty.test-support.js');
    const { createRun, updateRun, getRun, deleteRun } = await import('../runs/store.js');
    const { retainRunFixture } = await import('../run-engine/test-fixtures.js');
    const { piModels } = await import('../llm/index.js');
    const { readFeedbackLedger } = await import('./feedback-ledger.js');
    const faux = fauxProvider({ provider: 'openai', models: [{ id: 'curation-fixture' }] });
    (await piModels()).setProvider(faux.provider);
    let curationCalls = 0;
    let retryInjected = false;
    const response = (context: Context) => {
      const user = context.messages.at(-1);
      assert(user?.role === 'user' && typeof user.content === 'string');
      if (context.systemPrompt?.startsWith('Curate learning')) {
        curationCalls += 1;
        const packet = JSON.parse(user.content);
        if (!packet.entries[0].includes('provider-owned') && !retryInjected) {
          retryInjected = true;
          throw new Error('503 fixture provider cooling down');
        }
        const observed = packet.documents
          .filter((d: { path: string }) => d.path === 'artifacts/report.md')
          .slice(0, 2)
          .map((d: { runId: string; path: string; text: string }) => ({
            runId: d.runId,
            path: d.path,
            line: 1,
            quote: d.text,
          }));
        const reviewer = packet.documents.find(
          (d: { runId: string; path: string }) =>
            d.runId === packet.sourceRunId && d.path === 'artifacts/review-result.json',
        );
        return fauxAssistantMessage(
          JSON.stringify(
            packet.entries.map((entry: string) =>
              entry.includes('provider-owned')
                ? { outcome: 'drop', reason: 'Existing rule covers this check' }
                : {
                    outcome: 'keep',
                    reason: 'Two independent tasks confirm the wrong-order failure',
                    instruction: 'Inspect the order size before dispatch.',
                    observed,
                    confirmation: [
                      { runId: reviewer.runId, path: reviewer.path, line: 1, quote: reviewer.text },
                    ],
                    coverage: 'new',
                    moneyOrderBlocker: null,
                  },
            ),
          ),
        );
      }
      if (context.systemPrompt?.startsWith('You route learning'))
        return fauxAssistantMessage('["domain"]');
      return fauxAssistantMessage(
        '[{"id":"validate-order-size","symptom":"Wrong size","cause":"Missing check","action":"Inspect order size"}]',
      );
    };
    faux.setResponses(Array.from({ length: 30 }, () => response));
    const { createGatewayAuthRuntime } = await import('../security/auth.js');
    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: root });
    const person = auth.writer.createPrincipal({ type: 'service', displayName: 'Proof only' }, [
      { role: 'admin', scope: { kind: 'global' } },
    ]);
    const token = auth.writer.issueCredential(person.id, 'Disposable proof');
    const { createWebSocketServer, initServerGlobals, resetServerGlobalsForTests } =
      await import('../server.js');
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const wss = createWebSocketServer(server, auth);
    initServerGlobals();
    const ids: string[] = [];
    let socket: WebSocket | undefined;
    shutdown = async () => {
      socket?.terminate();
      resetServerGlobalsForTests();
      for (const id of ids) {
        updateRun(id, { status: 'cancelled' });
        await deleteRun(id);
      }
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    let requestId = 0;
    const rpc = <T>(method: string, params: unknown): Promise<T> =>
      new Promise((resolve, reject) => {
        const id = String(++requestId);
        const onMessage = (bytes: Buffer) => {
          const frame = JSON.parse(bytes.toString());
          if (frame.type !== 'res' || frame.id !== id) return;
          clearTimeout(timer);
          socket!.off('message', onMessage);
          frame.ok ? resolve(frame.payload) : reject(new Error(frame.error?.message));
        };
        const timer = setTimeout(() => {
          socket!.off('message', onMessage);
          reject(new Error('RPC deadline'));
        }, 10_000);
        socket!.on('message', onMessage);
        socket!.send(JSON.stringify({ type: 'req', id, method, params }));
      });
    await rpc('auth.connect', { clientKind: 'ui', token: token.secret });
    const seed = async (ticket: string, learning: string) => {
      const run = createRun({ project: 'curation', flowType: 'fix-bug', ticketOrPr: ticket });
      ids.push(run.id);
      const task = path.join(root, 'tasks', run.id);
      await mkdir(path.join(task, 'artifacts'), { recursive: true });
      await writeFile(path.join(task, 'TASK.md'), '# Proof');
      await writeFile(path.join(task, 'artifacts/learnings.md'), learning);
      await writeFile(
        path.join(task, 'artifacts/report.md'),
        'Observed wrong order size submitted.',
      );
      await writeFile(
        path.join(task, 'artifacts/review-result.json'),
        JSON.stringify({
          verdict: 'issues',
          issues: [
            {
              file: 'src/order.ts',
              line: 4,
              description: 'Independent reviewer confirms wrong order size',
              severity: 'major',
            },
          ],
        }),
      );
      updateRun(run.id, {
        taskFile: path.join(task, 'TASK.md'),
        status: 'done',
        agentContexts: [
          {
            id: 'reviewer',
            label: 'Independent review',
            role: 'review',
            status: 'complete',
            runId: run.id,
            slotId: null,
            reviewResultFile: 'artifacts/review-result.json',
          },
        ],
      });
      const captured = getRun(run.id);
      assert(captured);
      await retainRunFixture(captured);
      await rm(task, { recursive: true });
      return run.id;
    };
    await seed('PEER-2', '- Wrong order size needs a source check.');
    const dropped = await seed('SOURCE-1', '- Use the provider-owned market id.');
    const eligible = await seed('SOURCE-3', '- Wrong order size needs a source check.');
    const wait = async (runId: string) => {
      const deadline = Date.now() + 10_000;
      let run;
      do {
        run = (await rpc<RunGetResult>('run.get', { runId })).run;
        const latest = [...run.decisions]
          .reverse()
          .find((d) => d.payload?.kind === 'improvement')?.payload;
        if (latest?.kind === 'improvement' && latest.analysisStatus === 'no-changes') return run;
        await new Promise((resolve) => setImmediate(resolve));
      } while (Date.now() < deadline);
      throw new Error('Analysis did not finish');
    };
    await rpc('run.proposeImprovement', { runId: dropped });
    const dropRun = await wait(dropped);
    assert.equal(
      dropRun.decisions.some((d) => d.type === 'engine_learnings_draft'),
      false,
    );
    await rpc('run.proposeImprovement', { runId: eligible });
    const failedRun = await wait(eligible);
    assert.equal(
      failedRun.decisions.some((d) => d.type === 'engine_learnings_draft'),
      false,
    );
    assert.equal(
      (await readFeedbackLedger()).curations?.find((r) => r.runId === eligible)?.retryable,
      true,
    );
    await rpc('run.proposeImprovement', { runId: eligible });
    const keepRun = await wait(eligible);
    const gate = keepRun.decisions.find((d) => d.payload?.kind === 'learnings-draft');
    assert(gate?.payload?.kind === 'learnings-draft');
    assert.equal(gate.payload.drafts.length, 1);
    assert.equal(gate.resolvedAt ?? null, null);
    const ledger = await readFeedbackLedger();
    assert.equal(ledger.entries.length, 0);
    assert.equal(ledger.curations?.filter((r) => r.outcome === 'drop' && !r.retryable).length, 1);
    assert.equal(ledger.curations?.filter((r) => r.outcome === 'keep').length, 1);
    assert.equal(await readFile(path.join(library, 'antipatterns.md'), 'utf8'), rule);
    await rpc('run.resolveDecision', { runId: eligible, decisionId: gate.id, actionId: 'landed' });
    const approved = await readFeedbackLedger();
    assert.equal(
      approved.entries.length,
      1,
      'only the explicit fixture-human action consumes the learning',
    );
    assert.equal(await readFile(path.join(library, 'antipatterns.md'), 'utf8'), rule);
    await writeFile(
      path.join(out, 'receipt.json'),
      JSON.stringify(
        {
          pass: true,
          dropped,
          eligible,
          gateId: gate.id,
          consumptionBeforeExplicitApproval: ledger.entries.length,
          consumptionAfterFixtureApproval: approved.entries.length,
          canonicalLibraryUnchanged: true,
          curations: ledger.curations,
          curationCalls,
          canonicalSha256: createHash('sha256').update(rule).digest('hex'),
          provider: 'deterministic contract fixture, not semantic model proof',
        },
        null,
        2,
      ),
    );
  },
);
