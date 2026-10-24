import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const projects = await mkdtemp(path.join(os.tmpdir(), 'file-decision-resources-'));
process.env.FARMSLOT_PROJECTS_DIR = projects;
after(() => rm(projects, { recursive: true, force: true }));

const { decisionList, decisionResolve } = await import('../methods/decisions.js');
const { resourceRevisions } = await import('../resources/revisions.js');
const { loadPendingDecisions, scanDecisions } = await import('./fleet-monitor.js');
const key = { family: 'decisions', scope: 'farm' } as const;

test('resolving an explicit file decision id removes its source before acknowledging', async (t) => {
  const task = path.join(projects, 'demo', 'tasks', 'explicit-id');
  await mkdir(task, { recursive: true });
  t.after(() => rm(task, { recursive: true, force: true }));
  const file = path.join(task, '.pending_decision.json');
  await writeFile(
    file,
    JSON.stringify({
      id: 'explicit-decision',
      title: 'Needs an answer',
      actions: [{ id: 'acknowledge', label: 'Acknowledge' }],
    }),
  );
  assert((await loadPendingDecisions()).some((decision) => decision.id === 'explicit-decision'));
  const revision = resourceRevisions.revision(key);
  assert.deepEqual(
    await decisionResolve({ decisionId: 'explicit-decision', actionId: 'acknowledge' }),
    { resolved: true },
  );
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  assert.equal(resourceRevisions.revision(key), revision + 1);
  await scanDecisions();
  assert.equal(resourceRevisions.revision(key), revision + 1, 'An idle scan must not repeat it');
});

test('file create, edit and removal advance the inbox while unchanged scans stay quiet', async (t) => {
  const task = path.join(projects, 'demo', 'tasks', 'changing-file');
  await mkdir(task, { recursive: true });
  t.after(() => rm(task, { recursive: true, force: true }));
  await scanDecisions();
  const revision = resourceRevisions.revision(key);
  const file = path.join(task, '.pending_decision.json');
  await writeFile(file, JSON.stringify({ title: 'First version', actions: [] }));
  await scanDecisions();
  assert.equal(resourceRevisions.revision(key), revision + 1);
  assert((await decisionList()).decisions.some((decision) => decision.title === 'First version'));
  await delay(5);
  await scanDecisions();
  assert.equal(resourceRevisions.revision(key), revision + 1, 'Fallback read time is not a write');
  await writeFile(file, JSON.stringify({ title: 'Edited version', actions: [] }));
  await scanDecisions();
  assert.equal(resourceRevisions.revision(key), revision + 2);
  assert((await decisionList()).decisions.some((decision) => decision.title === 'Edited version'));
  await unlink(file);
  await scanDecisions();
  assert.equal(resourceRevisions.revision(key), revision + 3);
  assert(!(await decisionList()).decisions.some((decision) => decision.id === file));
  await scanDecisions();
  assert.equal(resourceRevisions.revision(key), revision + 3);
  assert.equal(resourceRevisions.revision({ family: 'decision', decisionId: file }), 0);
});

test('a corrupt decision is a read failure rather than a committed empty inbox', async (t) => {
  const task = path.join(projects, 'demo', 'tasks', 'corrupt-file');
  await mkdir(task, { recursive: true });
  t.after(() => rm(task, { recursive: true, force: true }));
  const file = path.join(task, '.pending_decision.json');
  const content = JSON.stringify({ id: 'keep-last-facts', title: 'Still pending', actions: [] });
  await writeFile(file, content);
  await scanDecisions();
  const revision = resourceRevisions.revision(key);
  await writeFile(file, '{incomplete');
  await assert.rejects(scanDecisions(), SyntaxError);
  await assert.rejects(decisionList(), SyntaxError);
  assert.equal(resourceRevisions.revision(key), revision + 1, 'Make the read failure visible');
  await assert.rejects(scanDecisions(), SyntaxError);
  assert.equal(resourceRevisions.revision(key), revision + 1, 'Repeated failures stay quiet');
  await writeFile(file, content);
  await scanDecisions();
  assert.equal(resourceRevisions.revision(key), revision + 2, 'Recovery must retry stale readers');
  await scanDecisions();
  assert.equal(resourceRevisions.revision(key), revision + 2);
});

test('an invalid action cannot acknowledge or remove a file decision', async (t) => {
  const task = path.join(projects, 'demo', 'tasks', 'invalid-action');
  await mkdir(task, { recursive: true });
  t.after(() => rm(task, { recursive: true, force: true }));
  const file = path.join(task, '.pending_decision.json');
  await writeFile(file, JSON.stringify({ id: 'refused-action', title: 'Pending', actions: [] }));
  await scanDecisions();
  const revision = resourceRevisions.revision(key);
  await assert.rejects(
    decisionResolve({ decisionId: 'refused-action', actionId: 'unknown' }),
    /Action not found/,
  );
  assert((await readFile(file, 'utf8')).includes('refused-action'));
  assert.equal(resourceRevisions.revision(key), revision);
});
