#!/usr/bin/env tsx
// Read a real gate diff and check its layout in an already-authenticated test
// client. Never resolves a gate, publishes a review, or injects editor state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const runId = process.env.FARMSLOT_REVIEW_RUN_ID;
assert(runId, 'Set FARMSLOT_REVIEW_RUN_ID to a real review gate');
assert(process.env.FARMSLOT_CDP_PORT, 'Select a dedicated test client CDP port');
const evidence = path.resolve(process.argv[2] ?? 'temp/gate-editor-styles');
mkdirSync(evidence, { recursive: true });
const helper = path.resolve('apps/command-center/scripts/cdp.mjs');
const walk = `function find(selector, root=document) {const found=root.querySelector(selector);if(found)return found;for(const el of root.querySelectorAll('*'))if(el.shadowRoot){const found=find(selector,el.shadowRoot);if(found)return found;}return null;}`;
function cdp(...args: string[]) {
  return execFileSync(process.execPath, [helper, ...args], { encoding: 'utf8', timeout: 30_000 });
}
function read(expression: string) {
  return JSON.parse(cdp('eval', '-', walk + `return {value:(${expression})};`)).value;
}
cdp('eval', '-', `location.hash=${JSON.stringify('#runs?run=' + runId)};return true;`);
for (let i = 0; i < 40; i++) {
  if (read('Boolean(find("diff-review")?.diff)')) break;
  await delay(250);
}
const request = read(`(()=>{const w=find('review-workspace');return {
  slotId:w.slotId,runId:w.runId,path:w._selectedFile,
  base:w._payload.reviewSnapshot?.baseSha ?? w._baseRef,
  head:w._payload.reviewSnapshot?.headSha,target:'head'
};})()`);
const result = JSON.parse(cdp('gateway', 'git.diff', JSON.stringify(request)));
assert(result.diff.length > 0, 'Gateway must return the real file diff');
assert.equal(read('find("diff-review").diff'), result.diff);
cdp('click', '-', '.dr-toggle-btn:first-child');
let panes: { x: number; top: number; width: number; float: string }[] = [];
for (let i = 0; i < 20; i++) {
  panes = read(`[...find('diff-review').querySelectorAll('.d2h-file-side-diff')].map(el=>{
    const r=el.getBoundingClientRect();return {x:r.x,top:r.top,width:r.width,float:getComputedStyle(el).float};
  })`);
  if (
    panes.length === 2 &&
    Math.abs(panes[0].top - panes[1].top) < 2 &&
    panes[1].x >= panes[0].x + panes[0].width - 2
  )
    break;
  await delay(100);
}
cdp('screenshot', '-', path.join(evidence, 'split.png'));
assert.equal(panes.length, 2);
assert(
  panes.every((pane) => pane.width > 100),
  'Packaged diff stylesheet must reach the gate shadow root',
);
assert(Math.abs(panes[0].top - panes[1].top) < 2, 'Split panes must sit alongside each other');
assert(panes[1].x >= panes[0].x + panes[0].width - 2, 'Modified code must appear to the right');
cdp('click', '-', '.dr-toggle-btn:last-child');
assert(
  read('find("diff-review").querySelectorAll(".d2h-file-diff .d2h-code-line-ctn").length') > 0,
);
assert.equal(read('find("diff-review").querySelectorAll(".d2h-file-side-diff").length'), 0);
cdp('screenshot', '-', path.join(evidence, 'unified.png'));
console.log(JSON.stringify({ status: 'pass', runId, bytes: result.diff.length, panes, evidence }));
