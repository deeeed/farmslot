// A scripted Codex app-server for review proofs over the real gateway review path and native
// host. It follows the reviewer prompt mechanically: one shell tool call, the checklist marks,
// then the result files (withholdMark: without the closing marks; skipMarks: with no mark at all).
// No model is called. Each turn's prompt, with the task file it names,
// is kept as prompt-<n>.txt for the proof to read.
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** What the next reviewer turn does; read from scenario.json beside the binary at each turn. */
export interface ScriptedReviewScenario {
  /** How long the one tool call stays open; omitted, it never ends. */
  toolMs?: number;
  verdict?: 'pass' | 'issues';
  /** Write the result files but end the turn without the closing marks. */
  withholdMark?: boolean;
  /** Write the result files without running any mark, so no signal is ever written. */
  skipMarks?: boolean;
}

const script = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 0.200.0'); process.exit(0); }
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const dir = path.dirname(fs.realpathSync(__filename));
const log = (entry) => fs.appendFileSync(path.join(dir, 'turns.log'), JSON.stringify(entry) + '\\n');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let thread;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    thread = m.params.threadId || 'scripted-' + process.pid;
    return send({ id: m.id, result: { thread: { id: thread } } });
  }
  if (m.method !== 'turn/start') {
    if (m.id !== undefined && m.method) send({ id: m.id, result: {} });
    return;
  }
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  const text = m.params.input.map((part) => part.text || '').join('\\n');
  const turn = 'turn-' + m.id;
  send({ id: m.id, result: { turn: { id: turn } } });
  send({ method: 'turn/started', params: { threadId: thread, turn: { id: turn } } });
  const mark = /run (\\S+ --checklist \\S+ --signal \\S+) N/.exec(text)?.[1];
  const files = /Write (\\S+?)(?: and (\\S+?))?, then /.exec(text);
  const task = /Follow (\\S+) top-to-bottom/.exec(text)?.[1];
  const turns = fs.readdirSync(dir).filter((name) => /^prompt-\\d+\\.txt$/.test(name)).length;
  fs.writeFileSync(path.join(dir, 'prompt-' + (turns + 1) + '.txt'), text + (task && fs.existsSync(task) ? '\\n--- ' + task + '\\n' + fs.readFileSync(task, 'utf8') : ''));
  log({ at: new Date().toISOString(), cwd: process.cwd(), mark, files: files && files.slice(1) });
  const item = { id: 'tool-' + m.id, type: 'commandExecution', command: 'sleep (scripted)' };
  send({ method: 'item/started', params: { threadId: thread, turnId: turn, item: { ...item, status: 'inProgress' } } });
  if (scenario.toolMs === undefined) return log({ hung: true });
  setTimeout(() => {
    send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { ...item, status: 'completed', aggregatedOutput: '' } } });
    // A completion re-ask names no fresh checklist command; it only ends the turn.
    if (mark) {
      const verdict = scenario.verdict || 'pass';
      const issues = verdict === 'pass' ? [] : [{ file: 'message.txt', line: 1, description: 'scripted finding', severity: 'major' }];
      if (!scenario.skipMarks) {
        execSync(mark + ' start', { stdio: 'ignore' });
        execSync(mark + ' 1', { stdio: 'ignore' });
      }
      fs.writeFileSync(files[1], (verdict === 'pass' ? 'VERDICT: PASS' : 'VERDICT: ISSUES') + '\\n');
      if (files[2]) fs.writeFileSync(files[2], JSON.stringify({ schemaVersion: 1, verdict, issues }));
      if (!scenario.withholdMark && !scenario.skipMarks) {
        execSync(mark + ' 2', { stdio: 'ignore' });
        execSync(mark + ' complete', { stdio: 'ignore' });
      }
    }
    log({ completed: true, marked: Boolean(mark) && !scenario.withholdMark && !scenario.skipMarks });
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
  }, scenario.toolMs);
});
`;

/** Installs the scripted app-server at `dir/codex`; `scenario` sets what its next turn does. */
export async function installScriptedCodex(dir: string) {
  const binary = path.join(dir, 'codex');
  await writeFile(binary, script);
  await chmod(binary, 0o700);
  return {
    binary,
    turnsLog: path.join(dir, 'turns.log'),
    /** Every turn's prompt and the task file it names, oldest first. */
    prompts: async () => {
      const names = (await readdir(dir)).filter((name) => /^prompt-\d+\.txt$/.test(name));
      const turn = (name: string) => Number(/\d+/.exec(name)![0]);
      return Promise.all(
        names
          .sort((a, b) => turn(a) - turn(b))
          .map((name) => readFile(path.join(dir, name), 'utf8')),
      );
    },
    scenario: (next: ScriptedReviewScenario) =>
      writeFile(path.join(dir, 'scenario.json'), JSON.stringify(next)),
  };
}
