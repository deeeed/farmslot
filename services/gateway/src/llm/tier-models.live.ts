// Live proof: per-tier model ids configured through Settings route through the real codex LB.
// An in-process gateway on a disposable FARMSLOT_HOME (never the operator's llm-config), the
// real Command Center UI in headless Chrome over CDP, and real calls to the local LB at
// 127.0.0.1:2455 with the gateway environment's CODEX_LB_API_KEY, which is never printed.
// Run from services/gateway:
//   TSX_TSCONFIG_PATH=tsconfig.json node --import tsx --test --test-force-exit \
//     src/llm/tier-models.live.ts
// Ports: LLM_TIER_PROOF_GATEWAY_PORT (8893), LLM_TIER_PROOF_VITE_PORT (5193),
// LLM_TIER_PROOF_CDP_PORT (9437). Output: LLM_TIER_PROOF_OUT (a directory outside the checkout).
import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const code = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const gatewayPort = Number(process.env.LLM_TIER_PROOF_GATEWAY_PORT ?? 8893);
const vitePort = Number(process.env.LLM_TIER_PROOF_VITE_PORT ?? 5193);
const cdpPort = String(process.env.LLM_TIER_PROOF_CDP_PORT ?? 9437);
const out = process.env.LLM_TIER_PROOF_OUT;
const TIERS = { fast: 'gpt-6-luna', standard: 'gpt-6-luna', smart: 'gpt-6-luna' } as const;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text: string) => console.error(`[proof] ${new Date().toISOString()} ${text}`);

test('Settings tier models route through the real codex LB', { timeout: 300_000 }, async (t) => {
  assert.ok(
    out && !path.resolve(out).startsWith(code + path.sep),
    'Set LLM_TIER_PROOF_OUT outside the checkout',
  );
  assert.ok(process.env.CODEX_LB_API_KEY, 'The gateway environment must carry CODEX_LB_API_KEY');
  await mkdir(out, { recursive: true });
  const evidence: Record<string, unknown> = {};
  const save = () => writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));

  // A disposable farm and home: the operator's llm-config is never read or written.
  const root = await mkdtemp(path.join(tmpdir(), 'llm-tier-proof-'));
  for (const key of Object.keys(process.env))
    if (/^FARMSLOT_|^GATEWAY_|^NODE_TOKEN$|^GW_URL$|^TMUX|^COPILOT_/.test(key))
      delete process.env[key];
  Object.assign(process.env, {
    FARMSLOT_ROOT: root,
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_GATEWAY_AUTH_MODE: 'token',
    GATEWAY_HOST: '127.0.0.1',
  });
  for (const dir of ['pool', 'projects', 'runs', 'home'])
    await mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
  for (const name of [
    'scripts',
    'packages',
    'services',
    'schemas',
    'node_modules',
    'CLAUDE.md',
    'package.json',
  ])
    await symlink(path.join(code, name), path.join(root, name));
  const profile = path.join(root, 'chrome');
  let vite: ChildProcess | undefined;
  let viteExited: Promise<unknown> | undefined;
  let http: Server | undefined;
  let closeClient: (() => void) | undefined;
  // One teardown, registered before anything starts. Each step runs even when an earlier one
  // fails: Chrome (its profile is under root), Vite and the gateway stop before root goes.
  t.after(async () => {
    const failures: unknown[] = [];
    const attempt = async (stepName: string, action: () => Promise<void> | void) => {
      try {
        await action();
      } catch (error) {
        failures.push(new Error(`teardown ${stepName}: ${String(error)}`, { cause: error }));
      }
    };
    await attempt('chrome', async () => {
      try {
        await execute('pkill', ['-f', profile]);
      } catch (error) {
        // pkill exits 1 when no process matched: Chrome is already gone.
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 1))
          throw error;
      }
    });
    await attempt('vite', async () => {
      if (!vite?.pid || !viteExited || vite.exitCode !== null || vite.signalCode !== null) return;
      try {
        // yarn starts vite in its own group; stop the whole group.
        process.kill(-vite.pid, 'SIGTERM');
      } catch (error) {
        // ESRCH: the group exited between the check and the signal.
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
      await viteExited;
    });
    await attempt('gateway', async () => {
      closeClient?.();
      if (!http) return;
      const server = http;
      // Open sockets (the UI, the client) would keep close() waiting forever.
      server.closeAllConnections();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      const stuck = delay(5_000).then(() => {
        throw new Error('the gateway did not close within 5 s');
      });
      await Promise.race([closed, stuck]);
    });
    await attempt('root', () => rm(root, { recursive: true, force: true }));
    if (failures.length > 0) throw new AggregateError(failures, 'proof teardown failed');
  });

  const { createGatewayAuthRuntime } = await import('../security/auth.js');
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'home') });
  const person = auth.writer.createPrincipal(
    { type: 'person', displayName: 'FIXTURE llm tier models proof' },
    [{ role: 'admin', scope: { kind: 'global' } }],
  );
  const credential = auth.writer.issueCredential(person.id, 'LLM tier proof');
  const grant = await auth.writer.exchangePersonCredential(credential.secret, {
    deviceName: 'LLM tier proof',
    deviceKind: 'cli',
  });
  // The browser signs in as a person with its own credential, never with an access token.
  const uiCredential = auth.writer.issueCredential(person.id, 'LLM tier proof browser');
  const { createWebSocketServer } = await import('../server.js');
  const { GatewayClient } = await import('../../../../packages/cli/src/gateway-client.js');
  const server = createServer();
  http = server;
  createWebSocketServer(server, auth);
  await new Promise<void>((resolve) => server.listen(gatewayPort, '127.0.0.1', resolve));
  const client = await new GatewayClient({
    url: `ws://127.0.0.1:${gatewayPort}/ws`,
    credential: { token: grant.accessToken },
    timeout: 120_000,
  }).connect();
  closeClient = () => client.close();
  const rpc = (method: string, params: Record<string, unknown> = {}) => client.call(method, params);

  // Today's operator file: anthropic, tiers by name, no overrides.
  await rpc('llm.config.set', {
    defaultProvider: 'anthropic',
    copilotModel: 'standard',
    intelligenceModel: 'fast',
    improvementModel: 'standard',
  });
  evidence.before = await rpc('llm.config.get');
  step('gateway up; config seeded');

  // --- The real Settings UI: type the codex-lb cells, save, reload, clear. ---
  const viteLog = await open(path.join(out, 'vite.log'), 'w');
  vite = spawn('yarn', ['dev'], {
    cwd: path.join(code, 'apps/command-center/ui'),
    env: {
      ...process.env,
      GATEWAY_PORT: String(gatewayPort),
      VITE_PORT: String(vitePort),
      FARMSLOT_DEV_UI_HMR: '0',
    },
    stdio: ['ignore', viteLog.fd, viteLog.fd],
    detached: true,
  });
  const started = vite;
  viteExited = new Promise((resolve) => started.on('exit', resolve));
  vite.on('exit', (status, signal) => step(`vite exited ${status ?? signal}`));
  const uiUrl = `http://127.0.0.1:${vitePort}`;
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(uiUrl, { signal: AbortSignal.timeout(2_000) })).ok) break;
    } catch (error) {
      // Vite is still starting; the loop bounds the wait.
      if (attempt > 300) throw error;
    }
    await delay(200);
  }
  step('ui up');
  // Chrome outlives the launcher and holds any inherited pipe, so the launcher gets none.
  const launcher = spawn(
    'bash',
    [
      path.join(code, 'apps/command-center/scripts/debug-chrome.sh'),
      '--headless',
      '--port',
      cdpPort,
      '--profile',
      profile,
      '--url',
      `${uiUrl}/#config/llm`,
    ],
    { stdio: 'ignore' },
  );
  const launched = await new Promise((resolve) => launcher.on('exit', resolve));
  assert.equal(launched, 0, `debug-chrome.sh exited ${String(launched)}`);
  step('chrome up');
  const cdpEnv = { ...process.env, FARMSLOT_CDP_PORT: cdpPort, FARMSLOT_UI_URL: uiUrl };
  const cdp = async (args: string[], input?: string) => {
    const child = execFile(
      process.execPath,
      [path.join(code, 'apps/command-center/scripts/cdp.mjs'), ...args],
      {
        env: cdpEnv,
        timeout: 65_000,
      },
    );
    if (input !== undefined) child.stdin?.end(input);
    let stdout = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(status, 0, `cdp ${args[0]} failed: ${stdout}`);
    // `eval` prints a string result raw and anything else as JSON.
    try {
      return JSON.parse(stdout || 'null');
    } catch {
      return stdout.trim();
    }
  };
  const page = 'config/llm';
  // The shadow-DOM chain to a cell, discovered in the page.
  const chainTo = (testId: string) =>
    cdp([
      'eval',
      page,
      `const find=(root,trail)=>{for(const el of root.querySelectorAll('*')){
         if(el.getAttribute('data-testid')===${JSON.stringify(testId)}) return [...trail,'[data-testid="'+${JSON.stringify(testId)}+'"]'];
         if(el.shadowRoot){const hit=find(el.shadowRoot,[...trail,el.localName]); if(hit) return hit;}}
         return null;};
       const deadline=Date.now()+15000; let hit=null;
       while(!(hit=find(document,[])) && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
       return hit && hit.join(' >>> ');`,
    ]);
  const loginForm = await cdp([
    'eval',
    page,
    `const deadline=Date.now()+15000;
     while(!document.querySelector('.auth-card') && document.querySelector('farm-app')?.connection!=='connected' && Date.now()<deadline)
       await new Promise(r=>setTimeout(r,100));
     return document.querySelector('.auth-card') ? 'browser' : 'connected';`,
  ]);
  if (loginForm === 'browser') {
    await cdp(['click', page, '.auth-mode:nth-child(1)']);
    await cdp(['fill', page, '.auth-input', '--stdin'], uiCredential.secret);
    await cdp(['click', page, '.auth-card button[type=submit]']);
  }
  step(`login ${loginForm}`);
  await cdp(['viewport', page, '1400', '900']);
  // First sign-in shows the release notes over the page; close them as a person would.
  evidence.whatsNew = await cdp([
    'eval',
    page,
    `const deep=(s,r=document)=>{const out=[...r.querySelectorAll(s)];
       for(const el of r.querySelectorAll('*')) if(el.shadowRoot) out.push(...deep(s,el.shadowRoot)); return out;};
     const deadline=Date.now()+5000; let button;
     while(!(button=deep('button').find((b)=>/^\\s*Got it\\s*$/i.test(b.textContent||''))) && Date.now()<deadline)
       await new Promise(r=>setTimeout(r,100));
     if(!button) return 'none'; button.click(); return 'dismissed';`,
  ]);
  const cell = async (tier: string) => {
    const selector = await chainTo(`tier-model-codex-lb-${tier}`);
    if (!selector) {
      await cdp(['screenshot', page, path.join(out, 'missing-cell.png')]);
      evidence.missingCell = await cdp([
        'eval',
        page,
        `return {connection: document.querySelector('farm-app')?.connection, hash: location.hash,
          text: document.body.innerText.slice(0, 800)}`,
      ]);
      await save();
    }
    assert.ok(selector, `the codex-lb ${tier} cell renders`);
    return selector;
  };
  // The cells once they show `expected` (the saved config arrives after the table renders),
  // or whatever they show when the wait runs out.
  const cellValues = (expected: Record<string, string>) =>
    cdp([
      'eval',
      page,
      `const expected=${JSON.stringify(expected)};
       const read=()=>{const values={};const walk=(root)=>{for(const el of root.querySelectorAll('*')){
         const id=el.getAttribute('data-testid')||''; if(id.startsWith('tier-model-codex-lb-')) values[id.slice(20)]=el.value;
         if(el.shadowRoot) walk(el.shadowRoot);}}; walk(document); return values;};
       const deadline=Date.now()+15000; let values=read();
       while(Object.keys(expected).some((k)=>values[k]!==expected[k]) && Date.now()<deadline){
         await new Promise(r=>setTimeout(r,100)); values=read();}
       return values;`,
    ]);
  const status = () =>
    cdp([
      'eval',
      page,
      `const find=(root)=>{for(const el of root.querySelectorAll('*')){
         if(el.getAttribute('data-testid')==='tier-models-status') return el.textContent.trim();
         if(el.shadowRoot){const hit=find(el.shadowRoot); if(hit) return hit;}} return null;};
       const deadline=Date.now()+10000; let text=null;
       while(!(text=find(document)) && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
       return text;`,
    ]);
  for (const [tier, id] of Object.entries(TIERS)) await cdp(['fill', page, await cell(tier), id]);
  evidence.uiTyped = await cellValues(TIERS);
  const saveButton = await chainTo('tier-models-save');
  evidence.uiClick = await cdp(['click', page, saveButton]);
  evidence.uiSaveStatus = await status();
  assert.equal(evidence.uiSaveStatus, 'Tier models saved');
  evidence.uiSavedBeforeReload = await rpc('llm.config.get');
  await cdp(['screenshot', page, path.join(out, 'settings-saved.png')]);
  await save();
  await cdp(['reload', page]);
  evidence.uiAfterReload = await cellValues(TIERS);
  assert.deepEqual(evidence.uiAfterReload, TIERS);
  const savedThroughUi = await rpc('llm.config.get');
  evidence.uiSavedConfig = savedThroughUi;
  assert.deepEqual((savedThroughUi as { tierModels?: unknown }).tierModels, { 'codex-lb': TIERS });
  await cdp(['screenshot', page, path.join(out, 'settings-reloaded.png')]);
  for (const tier of Object.keys(TIERS)) await cdp(['fill', page, await cell(tier), '']);
  await cdp(['click', page, await chainTo('tier-models-save')]);
  evidence.uiClearStatus = await status();
  assert.equal(evidence.uiClearStatus, 'Tier models saved');
  await cdp(['reload', page]);
  evidence.uiAfterClear = await cellValues({ fast: '', standard: '', smart: '' });
  assert.deepEqual(evidence.uiAfterClear, { fast: '', standard: '', smart: '' });
  evidence.uiClearedConfig = await rpc('llm.config.get');
  assert.deepEqual((evidence.uiClearedConfig as { tierModels?: unknown }).tierModels, {});
  await save();
  step('settings flow done');

  // --- The operator order: save the tiers, then switch the provider, then test each tier. ---
  await rpc('llm.config.set', { tierModels: { 'codex-lb': TIERS } });
  await rpc('llm.config.set', { defaultProvider: 'codex-lb' });
  evidence.switched = await rpc('llm.config.get');
  evidence.calls = {};
  for (const tier of Object.keys(TIERS)) {
    const started = Date.now();
    const result = (await rpc('llm.auth.test', { provider: 'codex-lb', model: tier })) as {
      ok: boolean;
      model: string;
      usage?: { model?: string; inputTokens?: number; outputTokens?: number };
      responsePreview?: string;
      error?: string;
      source?: string;
    };
    (evidence.calls as Record<string, unknown>)[tier] = {
      ...result,
      elapsedMs: Date.now() - started,
    };
    assert.equal(result.ok, true, `${tier}: ${result.error}`);
    assert.equal(result.usage?.model, TIERS[tier as keyof typeof TIERS]);
    // The test asks for exactly "OK"; an empty or cut-off reply is not an answer.
    assert.match(result.responsePreview ?? '', /^\s*OK\b/, `${tier} reply`);
  }

  step('tier calls done');
  await save();

  // Reversal.
  await rpc('llm.config.set', { defaultProvider: 'anthropic', tierModels: {} });
  const reversed = (await rpc('llm.config.get')) as {
    defaultProvider?: string;
    tierModels?: unknown;
  };
  evidence.reversed = reversed;
  await save();
  assert.equal(reversed.defaultProvider, 'anthropic');
  assert.deepEqual(reversed.tierModels, {});
  console.log(JSON.stringify(evidence, null, 2));
});
