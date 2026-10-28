#!/usr/bin/env node
// Normal navigation and real pointer actions, with read-only mounted-state observations.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const mode = process.argv[2];
assert(['decisions', 'native-unavailable'].includes(mode));
const caseDir = process.env.FARMSLOT_VIEW_SHARING_CASE;
const output = process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR;
assert(caseDir && output);
const fixture = JSON.parse(await readFile(path.join(caseDir, 'fixture.json'), 'utf8'));
assert.equal(fixture.sourceRoot, root);
const pageId = Number(process.env.FARMSLOT_VIEW_SHARING_WEB_PAGE_ID);
assert(Number.isInteger(pageId));
const call = (tool, args) => {
  const result = JSON.parse(
    execFileSync(
      'mcporter',
      ['call', 'agent-chrome.' + tool, '--args', JSON.stringify(args), '--output', 'json'],
      { cwd: root, env: process.env, encoding: 'utf8', timeout: 20000 },
    ),
  );
  assert(!result.isError);
  return result;
};
const cli = path.join(root, 'apps/command-center/scripts/cdp.mjs');
const evalPage = (route, body) =>
  JSON.parse(
    execFileSync(process.execPath, [cli, 'eval', route, body], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 18000,
    }),
  );
const image = (route, name) =>
  execFileSync(process.execPath, [cli, 'screenshot', route, path.join(output, name + '.png')], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
const save = (name, value) =>
  writeFile(path.join(output, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
const all = `const all=root=>Array.from(root.querySelectorAll('*')).flatMap(el=>[el,...(el.shadowRoot?all(el.shadowRoot):[])]);`;
if (mode === 'decisions') {
  const view = JSON.parse(await readFile(path.join(caseDir, 'view-fixture.json'), 'utf8'));
  const [first, second] = view.decisionIds;
  call('navigate_page', {
    pageId,
    type: 'url',
    url: process.env.FARMSLOT_VIEW_SHARING_WEB_BASE + '#decisions?gate=' + first,
    timeout: 15000,
  });
  const selected = evalPage(
    'decisions',
    `${all}const until=Date.now()+10000;let inbox;do{inbox=all(document).find(el=>el.localName==='decision-inbox');if(inbox?.selectedDecisionId===${JSON.stringify(first)}&&inbox._filtered?.length===1&&inbox._filtered[0].id===${JSON.stringify(first)})break;if(Date.now()>until)throw Error('Selected decision did not render');await new Promise(r=>setTimeout(r,100));}while(true);return {href:location.href,selectedId:inbox.selectedDecisionId,rendered:inbox._filtered.map(x=>x.id),text:inbox.shadowRoot.textContent};`,
  );
  image('decisions', 'decision-selected');
  execFileSync(process.execPath, [cli, 'click', 'decisions', 'a[title="Decisions"]'], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
  const cleared = evalPage(
    'decisions',
    `${all}const until=Date.now()+10000;let inbox;do{inbox=all(document).find(el=>el.localName==='decision-inbox');if(inbox?.selectedDecisionId===''&&[${JSON.stringify(first)},${JSON.stringify(second)}].every(id=>inbox._filtered.some(x=>x.id===id)))break;if(Date.now()>until)throw Error('Same-route decision navigation retained the old filter');await new Promise(r=>setTimeout(r,100));}while(true);return {href:location.href,selectedId:inbox.selectedDecisionId,rendered:inbox._filtered.map(x=>x.id),text:inbox.shadowRoot.textContent};`,
  );
  image('decisions', 'decisions-cleared');
  await save(mode, { selected, cleared, actualNavigationClick: true });
} else {
  call('navigate_page', {
    pageId,
    type: 'url',
    url:
      process.env.FARMSLOT_VIEW_SHARING_WEB_BASE +
      '#native?sessionId=view-share-missing-session&executionNodeId=view-share-missing-node&sharedView=1',
    timeout: 15000,
  });
  const selected = evalPage(
    'native',
    `${all}const until=Date.now()+10000;let view;do{view=all(document).find(el=>el.localName==='native-session-view');if(view?.initialSessionId==='view-share-missing-session'&&view.initialExecutionNodeId==='view-share-missing-node'&&view.selectedId==='view-share-missing-session'&&view.selectedNodeId==='view-share-missing-node'&&view.pollError==='Native execution node is unavailable for this owner'&&!view.session&&view.shadowRoot.textContent.includes(view.pollError))break;if(Date.now()>until)throw Error('Requested native identity did not reach an explicit unavailable state');await new Promise(r=>setTimeout(r,100));}while(true);return {href:location.href,requestedSession:view.initialSessionId,requestedNode:view.initialExecutionNodeId,selectedId:view.selectedId,selectedNode:view.selectedNodeId,error:view.pollError,sessionLoaded:Boolean(view.session),unavailableTextObserved:view.shadowRoot.textContent.includes(view.pollError)};`,
  );
  image('native', 'native-unavailable');
  call('navigate_page', {
    pageId,
    type: 'url',
    url: process.env.FARMSLOT_VIEW_SHARING_WEB_BASE + '#native',
    timeout: 15000,
  });
  const cleared = evalPage(
    'native',
    `${all}const until=Date.now()+10000;let view;do{view=all(document).find(el=>el.localName==='native-session-view');if(view?.initialSessionId===''&&view.initialExecutionNodeId===''&&view.selectedId!=='view-share-missing-session')break;if(Date.now()>until)throw Error('Same-route native identity did not clear');await new Promise(r=>setTimeout(r,100));}while(true);return {href:location.href,requestedSession:view.initialSessionId,requestedNode:view.initialExecutionNodeId,selectedId:view.selectedId};`,
  );
  image('native', 'native-cleared');
  await save(mode, { selected, cleared, loadedConversationClaim: false, providerLaunches: 0 });
}
console.log(JSON.stringify({ status: 'PASS', mode }));
