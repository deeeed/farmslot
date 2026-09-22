// Read-only proof against the operator gateway and browser. No model requests.
// Requires macOS and a saved Pi Anthropic login on each selected execution host.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const helper = 'apps/command-center/scripts/cdp.mjs';
const machines = (
  process.env.FARMSLOT_ACCOUNT_MACHINES || os.hostname().replace(/\.local$/, '')
).split(',');
const ui = process.env.FARMSLOT_UI_URL || 'http://localhost:5174/';
function cdp(...args) {
  return JSON.parse(
    execFileSync(process.execPath, [helper, ...args], {
      encoding: 'utf8',
      timeout: 70000,
      env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: '60000' },
    }),
  );
}
function rpc(params) {
  return cdp('gateway', 'providerAccounts.snapshot', JSON.stringify(params));
}
const before = rpc({ machines, forceRefresh: true });
for (const machine of before.machines) {
  for (const runner of ['claude', 'codex', 'grok', 'cursor', 'pi', 'opencode']) {
    const row = machine.runners.find((r) => r.runner === runner);
    assert.ok(row?.inventory, `${machine.machine}/${runner}: missing inventory`);
    assert.equal(row.inventory.scope, 'host-default');
    assert.equal(
      new Set(row.inventory.accounts.map((a) => a.id)).size,
      row.inventory.accounts.length,
    );
    for (const account of row.inventory.accounts) {
      assert.ok(
        Object.keys(account).every((key) =>
          ['id', 'provider', 'label', 'email', 'status', 'authType', 'source'].includes(key),
        ),
      );
      assert.ok(account.provider);
    }
  }
  const pi = machine.runners.find((r) => r.runner === 'pi');
  assert.ok(
    pi.inventory.accounts.some((a) => a.provider === 'anthropic' && a.status === 'ready'),
    `${machine.machine}: Anthropic login must be ready`,
  );
  assert.equal(pi.usage, null, 'Pi must not borrow another runner quota or identity');
}
const missing = rpc({ machines: ['runner-inventory-proof-missing'], forceRefresh: true });
assert.equal(missing.machines[0].reachable, false);
assert.ok(missing.machines[0].runners.every((r) => !r.inventory?.accounts.length));

const walk = `const walk = r => [...r.querySelectorAll('*')].flatMap(e => [e, ...(e.shadowRoot ? walk(e.shadowRoot) : [])]);`;
for (const machine of before.machines) {
  const route = `config/pool/${machine.machine}`;
  cdp('goto', `${ui.split('#')[0]}#${route}`, '--new');
  cdp('focus', route);
  try {
    const result = cdp(
      'eval',
      route,
      `
      const until = async test => { const end=Date.now()+45000; while(Date.now()<end){const value=test();if(value)return value;await new Promise(r=>setTimeout(r,250));}throw Error('Config refresh timed out');};
      const button=await until(()=>document.querySelector('[data-testid=config-seats-refresh]'));
      const seats=document.querySelector('[data-testid=config-runner-seats]');
      button.click();
      await until(()=>button.disabled);
      await until(()=>!button.disabled && seats.querySelector('[data-runner=pi] [data-provider=anthropic]'));
      return {pi: [...seats.querySelectorAll('[data-runner=pi] [data-provider]')].map(e=>({provider:e.dataset.provider,text:e.textContent})),opencode:seats.querySelector('[data-runner=opencode]')?.textContent};
    `,
    );
    const expected = machine.runners.find((r) => r.runner === 'pi').inventory.accounts;
    assert.deepEqual(
      result.pi.map((a) => a.provider),
      expected.map((a) => a.provider),
    );
    assert.ok(result.pi.some((a) => a.provider === 'anthropic' && a.text.includes('ready')));
    assert.ok(result.opencode);
    const commands = machine.runners
      .filter((r) => r.inventory.inspection)
      .map((r) => ({ runner: r.runner, command: r.inventory.inspection.command }));
    cdp('focus', route);
    for (const entry of commands) {
      cdp('click', route, `button[aria-label="Copy status command for ${entry.runner}"]`);
      const copied = cdp(
        'eval',
        route,
        `
      const entry=${JSON.stringify(entry)};
        const row=document.querySelector('[data-testid=config-runner-seats]').querySelector('[data-runner='+entry.runner+']');
        const control=row.querySelector('runner-account-command');
        const button=control?.shadowRoot?.querySelector('button');
        if(!button)throw Error('Missing copy command for '+entry.runner);
        const end=Date.now()+3000;
        while(button.textContent.trim()!=='Copied'&&Date.now()<end)await new Promise(r=>setTimeout(r,50));
        if(button.textContent.trim()!=='Copied')throw Error('Copy failed for '+entry.runner);
      return {copied:true};
    `,
      );
      assert.equal(copied.copied, true);
      assert.ok(
        execFileSync('pbpaste', { encoding: 'utf8' }) === entry.command,
        `Clipboard command mismatch for ${entry.runner}`,
      );
    }
  } finally {
    cdp('close', route);
  }
}
cdp('goto', `${ui.split('#')[0]}#fleet`, '--new');
cdp('focus', 'fleet');
// Reuse fleet's real account button; no store or component-state injection.
const result = cdp(
  'eval',
  'fleet',
  `${walk}
  const until=async test=>{const end=Date.now()+45000;while(Date.now()<end){const v=test();if(v)return v;await new Promise(r=>setTimeout(r,250));}throw Error('Fleet accounts timed out');};
  const canvas=await until(()=>document.querySelector('fleet-canvas')?.shadowRoot);
  [...canvas.querySelectorAll('button')].find(b=>b.textContent.trim()==='machine').click();
  const group=await until(()=>walk(document).find(e=>e.tagName==='MACHINE-GROUP'&&e.machine===${JSON.stringify(machines[0])}));
  group.shadowRoot.querySelector('[data-testid=machine-accounts-btn]').click();
  await until(()=>group.shadowRoot.querySelector('[data-runner=pi] [data-provider=anthropic]'));
  const text=group.shadowRoot.querySelector('[data-runner=pi]').textContent;
  group.shadowRoot.querySelector('.setup-close').click();
  return {pi:text};
`,
);
assert.ok(result.pi.includes('OAuth'));
console.log(
  JSON.stringify({
    pass: true,
    machines,
    claims: [
      'provider-separated inventory',
      'no Pi quota/identity borrowing',
      'unreachable host',
      'Config refresh',
      'copy status command clipboard',
      'Fleet accounts',
    ],
  }),
);
