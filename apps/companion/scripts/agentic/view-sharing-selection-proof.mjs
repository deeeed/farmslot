#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readForegroundClipboard } from './clipboard-probe/read.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const mode = process.argv[2];
const caseDir = process.env.FARMSLOT_VIEW_SHARING_CASE;
const artifacts = process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR;
assert(caseDir && artifacts);
const fixture = JSON.parse(await readFile(path.join(caseDir, 'fixture.json'), 'utf8'));
assert.equal(fixture.sourceRoot, root);
const save = (name, value) =>
  writeFile(path.join(artifacts, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
const browser = (tool, args) => {
  const r = JSON.parse(
    execFileSync(
      'mcporter',
      ['call', 'agent-chrome.' + tool, '--args', JSON.stringify(args), '--output', 'json'],
      { cwd: root, env: process.env, encoding: 'utf8', timeout: 20000 },
    ),
  );
  assert(!r.isError);
  return r;
};
if (mode === 'stage-browser-filters') {
  const pageId = Number(process.env.FARMSLOT_VIEW_SHARING_WEB_PAGE_ID);
  const url =
    process.env.FARMSLOT_VIEW_SHARING_WEB_BASE +
    '#runs?projects=' +
    encodeURIComponent(fixture.project) +
    '&machines=' +
    encodeURIComponent(fixture.machine);
  browser('navigate_page', { pageId, type: 'url', url, timeout: 15000 });
  const helper = path.join(root, 'apps/command-center/scripts/cdp.mjs');
  const code = `const all=root=>Array.from(root.querySelectorAll('*')).flatMap(el=>[el,...(el.shadowRoot?all(el.shadowRoot):[])]);const until=Date.now()+10000;let shell;do{shell=all(document).find(el=>el.localName==='farm-app');if(shell?.globalFilters.projects.includes(${JSON.stringify(fixture.project)}))break;if(Date.now()>until)throw Error('Normal URL filter navigation did not apply');await new Promise(r=>setTimeout(r,100));}while(true);return {href:location.href,filters:shell.globalFilters};`;
  const first = JSON.parse(
    execFileSync(process.execPath, [helper, 'eval', 'runs', code], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 15000,
    }),
  );
  browser('navigate_page', { pageId, type: 'reload', ignoreCache: true, timeout: 15000 });
  const retained = JSON.parse(
    execFileSync(process.execPath, [helper, 'eval', 'runs', code], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 15000,
    }),
  );
  assert.deepEqual(retained.filters, { projects: [fixture.project], machines: [fixture.machine] });
  await save(mode, { first, retained, normalNavigationAndReload: true, storageRead: false });
} else if (mode === 'open-document-web' || mode === 'open-history-web') {
  const name = mode === 'open-document-web' ? 'document-clipboard' : 'history-clipboard';
  const copied = JSON.parse(await readFile(path.join(artifacts, name + '.json'), 'utf8'));
  browser('navigate_page', {
    pageId: Number(process.env.FARMSLOT_VIEW_SHARING_WEB_PAGE_ID),
    type: 'url',
    url: copied.url,
    timeout: 15000,
  });
  await save(mode, { requested: copied.url });
} else if (mode === 'document-web' || mode === 'history-web') {
  const document = mode === 'document-web';
  const runId = fixture.runs[0].id;
  const code = document
    ? `const all=root=>Array.from(root.querySelectorAll('*')).flatMap(el=>[el,...(el.shadowRoot?all(el.shadowRoot):[])]);const until=Date.now()+12000;let nodes,view;do{nodes=all(document);view=nodes.find(el=>el.localName==='run-detail');if(view?._evidenceLightboxOpen&&nodes.some(el=>el.textContent?.includes('The displayed document belongs to the retained source run.')))break;if(Date.now()>until)throw Error('Retained document did not render');await new Promise(r=>setTimeout(r,100));}while(true);const item=view._evidenceLightboxItems[view._evidenceLightboxIndex];if(view.run?.id!==${JSON.stringify(runId)}||item.path!=='artifacts/view-sharing-report.md')throw Error('Wrong mounted artifact identity');return {href:location.href,runId:view.run.id,artifact:item.path,bodyObserved:true};`
    : `const all=root=>Array.from(root.querySelectorAll('*')).flatMap(el=>[el,...(el.shadowRoot?all(el.shadowRoot):[])]);const until=Date.now()+12000;let nodes,list,shell;do{nodes=all(document);list=nodes.find(el=>el.localName==='run-list');shell=nodes.find(el=>el.localName==='farm-app');if(list?.tab==='all'&&list?.shadowRoot?.textContent?.includes('Different control run'))break;if(Date.now()>until)throw Error('Unfiltered History did not render');await new Promise(r=>setTimeout(r,100));}while(true);if(shell.globalFilters.projects.length||shell.globalFilters.machines.length)throw Error('Inherited saved filters');return {href:location.href,tab:list.tab,filters:shell.globalFilters,controlRunObserved:true};`;
  const helper = path.join(root, 'apps/command-center/scripts/cdp.mjs');
  const observed = JSON.parse(
    execFileSync(process.execPath, [helper, 'eval', document ? 'run/' + runId : 'runs', code], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 20000,
    }),
  );
  await save(mode, observed);
  execFileSync(
    process.execPath,
    [helper, 'screenshot', document ? 'run/' + runId : 'runs', path.join(artifacts, mode + '.png')],
    { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
  );
} else {
  const { createAgentDeviceClient } = await import('agent-device');
  const device = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
  const sessions = (await device.sessions.list()).filter(
    (s) => s.device.id === process.env.ADB_SERIAL,
  );
  assert.equal(sessions.length, 1);
  const selection = {
    session: sessions[0].name,
    platform: 'android',
    target: 'mobile',
    serial: process.env.ADB_SERIAL,
  };
  if (mode === 'ensure-history') {
    let screen = await device.capture.snapshot({ ...selection, raw: true, depth: 50 });
    const alreadySelected = screen.nodes.some(
      (n) => n.label === 'Review history' || n.value === 'Review history',
    );
    if (!alreadySelected) {
      const button = screen.nodes.find((n) => n.label === 'History' && n.visibleToUser !== false);
      assert(button, 'The actual History control is unavailable');
      await device.interactions.press({
        ...selection,
        selector: 'label="History"',
        settle: true,
        verify: true,
      });
    }
    const until = Date.now() + 10000;
    let scopeObserved = false;
    do {
      screen = await device.capture.snapshot({ ...selection, raw: true, depth: 50 });
      scopeObserved = screen.nodes.some(
        (n) => n.label === 'Review history' || n.value === 'Review history',
      );
      if (scopeObserved) break;
      assert(Date.now() < until, 'The actual History scope did not become visible');
      await new Promise((r) => setTimeout(r, 150));
    } while (!scopeObserved);
    await save(mode, { screen, alreadySelected, actualScopeObserved: scopeObserved });
  } else if (mode === 'open-files' || mode === 'open-runs') {
    await device.apps.open({
      ...selection,
      app: process.env.FARMSLOT_RECIPE_APP_ID,
      url:
        'farmslot-development:///' +
        (mode === 'open-files' ? 'artifacts/' + fixture.runs[0].id : 'runs'),
      relaunch: false,
      noRecord: true,
    });
  } else if (mode === 'document-clipboard' || mode === 'history-clipboard') {
    const measured = await readForegroundClipboard({
      adb: path.join(process.env.ANDROID_HOME, 'platform-tools/adb'),
      serial: selection.serial,
      receiptPath: process.env.FARMSLOT_VIEW_SHARING_CLIPBOARD_PROBE,
      artifactDir: artifacts,
    });
    const url = new URL(measured.text);
    assert.equal(url.origin + url.pathname, process.env.FARMSLOT_VIEW_SHARING_WEB_BASE);
    const [route, query = ''] = url.hash.split('?');
    const params = new URLSearchParams(query);
    assert.equal(params.get('sharedView'), '1');
    assert(params.has('projects') && params.get('projects') === '');
    assert(params.has('machines') && params.get('machines') === '');
    if (mode === 'document-clipboard') {
      assert.equal(route, '#run/' + fixture.runs[0].id);
      assert.equal(params.get('artifactRun'), fixture.runs[0].id);
      assert.equal(params.get('artifact'), 'artifacts/view-sharing-report.md');
    } else {
      assert.equal(route, '#runs');
      assert.equal(params.get('runsTab'), 'all');
    }
    await save(mode, {
      url: measured.text,
      route,
      selection: Object.fromEntries(params),
      reader: measured.reader,
    });
  } else throw Error('Unknown selection proof mode ' + mode);
}
console.log(JSON.stringify({ status: 'PASS', mode }));
