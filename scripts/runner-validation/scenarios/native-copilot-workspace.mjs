import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'native-copilot-workspace';
const exec = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stages = [
  'create',
  'edit',
  'finish-edit',
  'inspect-edit',
  'workspace',
  'layout',
  'presentation',
  'changes-limit',
  'reservation',
  'request-approval',
  'deny',
  'approve',
  'interrupt',
  'stop',
  'context-question',
  'context-answer',
  'context-fail',
  'context-resume',
  'close',
];
const viewSelector = 'native-session-view >>> ';
const viewRoot = "document.querySelector('native-session-view')?.shadowRoot";

/** Stage boundaries are durable reservations. An interrupted invocation never sends again. */
export async function runScenario({ runnerAdapter, timeoutMs = 180000, outDir, model }) {
  const runner = runnerAdapter.RUNNER_ID;
  const stage = process.env.FARMSLOT_NATIVE_UI_STAGE;
  const report = { runner, stage, checks: [], pass: false, pending: false };
  let state;
  try {
    assert.ok(stages.includes(stage), `Set FARMSLOT_NATIVE_UI_STAGE to ${stages.join(', ')}`);
    assert.equal(new URL(process.env.FARMSLOT_GATEWAY).origin, 'ws://127.0.0.1:18777');
    assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
    const uiUrl = new URL(process.env.FARMSLOT_UI_URL);
    assert.equal(uiUrl.origin, 'http://127.0.0.1:18778');
    const route = uiUrl.hash.slice(1) || 'fleet';
    const validationRoot = fs.realpathSync(path.join(ROOT, 'temp/native-validation'));
    const inside = (target) => {
      const relative = path.relative(validationRoot, target);
      assert.ok(
        relative &&
          relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative),
        'Use a private path inside checkout temp/native-validation',
      );
      return target;
    };
    assert.ok(
      process.env.FARMSLOT_NATIVE_UI_STATE && process.env.FARMSLOT_NATIVE_UI_FIXTURE,
      'Set private state file and disposable fixture directory',
    );
    const fixture = inside(fs.realpathSync(process.env.FARMSLOT_NATIVE_UI_FIXTURE));
    const statePath = inside(path.resolve(process.env.FARMSLOT_NATIVE_UI_STATE));
    const stateParent = fs.realpathSync(path.dirname(statePath));
    if (stateParent !== validationRoot) inside(stateParent);
    const sourcePath = inside(fs.realpathSync(path.join(fixture, 'src/greeting.ts')));
    assert.ok(
      sourcePath.startsWith(`${fixture}${path.sep}`),
      'Greeting fixture escapes its workspace',
    );
    const evidenceDir = outDir ?? path.join(validationRoot, 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    state = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
      : { fixture, runner, marker: randomUUID(), commands: {} };
    assert.equal(state.fixture, fixture);
    assert.equal(state.runner, runner);
    const save = () => {
      const temporary = `${statePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, statePath);
    };
    const cdp = async (...args) => {
      try {
        const { stdout } = await exec(
          process.execPath,
          [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
          { cwd: ROOT, env: process.env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
        );
        return JSON.parse(stdout);
      } catch (error) {
        throw new Error(
          `CDP ${args[0]} failed (${error.code ?? 'unclassified'}); inspect the isolated validation logs.`,
        );
      }
    };
    const evaluate = async (expression) =>
      (await cdp('eval', route, `return { value: await (async () => { ${expression} })() };`))
        .value;
    const rpc = (method, params = {}) => cdp('gateway', method, JSON.stringify(params));
    const click = (selector) =>
      evaluate(
        `const element = ${viewRoot}?.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) throw new Error('Control unavailable'); element.click(); return { clicked:true };`,
      );
    const observe = () =>
      cdp('eval', route, '--file', path.join(ROOT, 'apps/command-center/probes/native-copilot.js'));
    const until = async (read, description) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await pause(1000);
      }
      throw new Error(
        `Timed out waiting for ${description}. State preserved; no command will be resent.`,
      );
    };
    const read = async () => {
      assert.ok(state.sessionId, 'Run create first');
      let after = 0;
      const events = [];
      let page;
      do {
        page = await rpc('native.session.read', { sessionId: state.sessionId, after, limit: 200 });
        events.push(...page.events);
        after = page.cursor;
      } while (page.hasMore);
      assert.equal(page.session.id, state.sessionId);
      assert.equal(page.session.runner, runner);
      if (state.model) assert.equal(page.session.model, state.model);
      if (state.mode) assert.equal(page.session.mode, state.mode);
      assert.equal(fs.realpathSync(page.session.cwd), fixture);
      return { ...page, events };
    };
    const assertSelected = async () => {
      const ui = await observe();
      assert.equal(ui.sessionId, state.sessionId, 'Selected session differs from the scenario');
      assert.ok(ui.identity?.includes(state.sessionId), 'Session details disagree with selector');
      return ui;
    };
    const selectSaved = async () => {
      const ui = await observe();
      if (ui.sessionId !== state.sessionId) {
        await until(
          () =>
            evaluate(
              `return Array.from(${viewRoot}?.querySelector('[data-testid="native-session-select"]')?.options??[]).some(option=>option.value===${JSON.stringify(state.sessionId)});`,
            ),
          'saved session option',
        );
        await cdp(
          'select',
          route,
          `${viewSelector}[data-testid="native-session-select"]`,
          state.sessionId,
        );
      }
      await until(async () => {
        const next = await observe();
        return next.sessionId === state.sessionId && next.identity?.includes(state.sessionId);
      }, 'saved session identity');
    };
    const reload = async () => {
      await cdp('goto', uiUrl.href);
      await until(async () => {
        const ui = await observe();
        return ui.sessionId === state.sessionId && ui.identity?.includes(state.sessionId);
      }, 'same session after page refresh');
    };
    const check = (name, detail = {}) => report.checks.push({ name, pass: true, ...detail });
    const screenshot = async (name) => {
      const file = path.join(evidenceDir, `native-ui-${runner}-${state.marker}-${name}.png`);
      await cdp('screenshot', route, file);
      return file;
    };
    const reconcileCommand = async (key, snapshot) => {
      const command = state.commands[key];
      assert.ok(command, `Run the send stage for ${key} first`);
      const ids = [
        ...new Set(
          snapshot.events
            .filter(
              (event) =>
                event.sequence > command.after &&
                event.text === command.text &&
                ['command.submitted', 'command.accepted'].includes(event.type),
            )
            .map((event) => event.commandId),
        ),
      ];
      assert.ok(ids.length <= 1, 'The task was submitted more than once');
      if (ids.length) {
        assert.ok(ids[0]);
        if (command.id) assert.equal(ids[0], command.id);
        command.id = ids[0];
        save();
      }
      return command;
    };
    const sendOnce = async (key, instruction) => {
      await assertSelected();
      if (!state.commands[key]) {
        const before = await read();
        assert.equal(before.session.state, 'idle');
        const text = `[Farmslot UI validation ${state.marker}:${key}]\n${instruction}`;
        await cdp('fill', route, `${viewSelector}[data-testid="native-message"]`, text);
        await until(async () => (await observe()).sendEnabled, 'enabled Send control');
        state.commands[key] = { after: before.cursor, text, attempted: true };
        save();
        await click('[data-testid="native-send"]');
      }
      return until(async () => {
        const snapshot = await read();
        return (await reconcileCommand(key, snapshot)).id;
      }, 'durable UI command identity');
    };
    const finish = async (key) => {
      const snapshot = await until(async () => {
        const current = await read();
        const command = await reconcileCommand(key, current);
        if (!command.id) return false;
        return current.pendingRequests.some((event) => event.commandId === command.id) ||
          current.events.some(
            (event) => event.commandId === command.id && event.type === 'turn.completed',
          )
          ? current
          : false;
      }, 'turn completion or pending interaction');
      const command = state.commands[key];
      const pending = snapshot.pendingRequests.filter((event) => event.commandId === command.id);
      if (pending.length) {
        report.pending = true;
        report.requests = pending.map((event) => ({ id: event.request?.id, type: event.type }));
        report.next =
          'Inspect the pending request in the UI, answer explicitly, then rerun the finish stage.';
        return null;
      }
      const completed = snapshot.events.find(
        (event) => event.commandId === command.id && event.type === 'turn.completed',
      );
      assert.ok(completed);
      return completed;
    };

    assert.equal(
      await evaluate('return location.origin;'),
      uiUrl.origin,
      'CDP selected a different UI origin',
    );
    await cdp('focus', route);
    await observe();
    if (stage === 'create') {
      if (!state.sessionId && !state.creationAttempted) {
        const catalog = await rpc('native.session.catalog');
        const choice = catalog.runners.find((option) => option.runner === runner);
        assert.ok(choice, 'Runner lacks native UI catalog entry');
        const selectedModel = process.env.FARMSLOT_NATIVE_UI_MODEL ?? model ?? choice.defaultModel;
        assert.ok(choice.models.includes(selectedModel), 'Requested model is not selectable');
        const context = catalog.contexts.find((item) => path.resolve(item.cwd) === fixture);
        assert.ok(context, 'Register the disposable local slot in the isolated pool first');
        await click('[data-testid="native-new"]');
        await evaluate(`const button=Array.from(${viewRoot}?.querySelectorAll('button')??[]).find(item=>item.textContent.trim()==='Refresh sessions');
          if(!button || button.disabled)throw new Error('Refresh sessions unavailable');button.click();return true;`);
        await until(
          () =>
            evaluate(
              `return Array.from(${viewRoot}?.querySelector('[data-testid="native-context"]')?.options??[]).some(option=>option.value===${JSON.stringify(context.cwd)});`,
            ),
          'configured fixture option',
        );
        for (const label of [runner, selectedModel])
          await evaluate(
            `const picker=${viewRoot}?.querySelector('runner-model-effort-picker')?.shadowRoot; const button=Array.from(picker?.querySelectorAll('button')??[]).find(item=>item.textContent.trim()===${JSON.stringify(label)}); if(!button || button.disabled) throw new Error('Picker choice unavailable'); button.click(); return {clicked:true};`,
          );
        await cdp('select', route, `${viewSelector}[data-testid="native-context"]`, context.cwd);
        state.model = selectedModel;
        state.mode = process.env.FARMSLOT_NATIVE_UI_MODE ?? 'default';
        assert.ok(choice.modes.includes(state.mode), 'Requested interaction mode is unavailable');
        await cdp('select', route, `${viewSelector}[data-testid="native-mode"]`, state.mode);
        state.beforeSessions = (await rpc('native.session.list')).sessions.map(
          (session) => session.id,
        );
        state.creationAttempted = true;
        save();
        await click('[data-testid="native-create"]');
      }
      if (!state.sessionId) {
        state.sessionId = await until(async () => {
          const candidates = (await rpc('native.session.list')).sessions.filter(
            (session) =>
              !state.beforeSessions.includes(session.id) &&
              session.runner === runner &&
              fs.realpathSync(session.cwd) === fixture,
          );
          assert.ok(candidates.length <= 1, 'More than one newly created fixture session');
          return candidates[0]?.id;
        }, 'new session');
        save();
      }
      await selectSaved();
      await read();
      check('ui-created-owned-session', { sessionId: state.sessionId });
    } else {
      assert.ok(state.sessionId, 'Run create first');
      await selectSaved();
      if (stage === 'edit' || stage === 'finish-edit') {
        if (stage === 'edit')
          await sendOnce(
            'edit',
            'Read and edit src/greeting.ts in this workspace. Change the greeting from Hello to Hello from Farmslot, preserving its existing structure. Use available file tools or a read-only shell command to read that file. Do not modify other files, install dependencies, or use the network. Then briefly explain the change.',
          );
        const completed = await finish('edit');
        if (completed) {
          assert.equal(completed.status, 'completed');
          assert.match(fs.readFileSync(sourcePath, 'utf8'), /Hello from Farmslot/);
          check('ui-edit-completed-with-file-effect');
        }
      } else if (stage === 'inspect-edit') {
        const before = await read();
        const pending = before.pendingRequests.find(
          (event) =>
            event.commandId === state.commands.edit?.id &&
            event.type === 'approval.requested' &&
            event.request?.tool,
        );
        assert.ok(pending, 'Expected a pending edit with normalized proposed tool details');
        const proposed = JSON.stringify(pending.request.tool.input);
        assert.ok(
          proposed.includes(sourcePath) && proposed.includes('Hello from Farmslot'),
          'Proposed edit differs from fixture task',
        );
        assert.ok(
          !fs.readFileSync(sourcePath, 'utf8').includes('Hello from Farmslot'),
          'Edit ran before approval',
        );
        await reload();
        await until(
          async () => (await observe()).requests.some((item) => item.id === pending.request.id),
          'same pending edit after refresh',
        );
        const rendered = await evaluate(
          `return ${viewRoot}?.querySelector('[data-request-id="${pending.request.id}"] [data-testid="native-request-tool"]')?.textContent??'';`,
        );
        assert.ok(
          rendered.includes(sourcePath) && rendered.includes('Hello from Farmslot'),
          'Permission controls omit the proposed file or diff',
        );
        check('refreshed-permission-displays-exact-proposed-file-and-diff', {
          requestId: pending.request.id,
          screenshot: await screenshot('proposed-edit'),
        });
      } else if (stage === 'workspace') {
        const completed = await finish('edit');
        assert.ok(completed, 'Finish the edit before inspecting workspace');
        assert.equal(completed.status, 'completed');
        await evaluate(
          `const panel=document.querySelector('chat-panel');if(panel?.querySelector('.cp-drawer.fullscreen')){const button=Array.from(panel.querySelectorAll('.cp-header button')).find(item=>item.textContent.trim()==='Restore size');if(!button)throw new Error('Restore drawer control absent');button.click();}return {defaultDrawer:true};`,
        );
        await evaluate(
          `if(!${viewRoot}?.querySelector('native-workspace')){const button=${viewRoot}?.querySelector('[data-testid="native-workspace-toggle"]');if(!button)throw new Error('Workspace toggle absent');button.click();}return {opened:true};`,
        );
        await evaluate(
          `const workspace=${viewRoot}?.querySelector('native-workspace')?.shadowRoot; const tab=Array.from(workspace?.querySelectorAll('[role="tab"]')??[]).find(item=>item.textContent.trim()==='Changes'); if(!tab) throw new Error('Changes tab absent');tab.click();return {clicked:true};`,
        );
        await until(
          () =>
            evaluate(
              `const button=${viewRoot}?.querySelector('native-workspace')?.shadowRoot?.querySelector('[data-path="src/greeting.ts"]'); if(!button) return false;button.click();return true;`,
            ),
          'changed file',
        );
        await until(
          () =>
            evaluate(
              `return Boolean(${viewRoot}?.querySelector('native-workspace')?.shadowRoot?.querySelector('diff-review')?.textContent.includes('Hello from Farmslot'));`,
            ),
          'rendered diff',
        );
        const diff = await rpc('native.session.workspace.diff', {
          sessionId: state.sessionId,
          path: 'src/greeting.ts',
        });
        assert.match(diff.diff, /\+.*Hello from Farmslot/);
        await evaluate(
          `const button=${viewRoot}?.querySelector('native-workspace')?.shadowRoot?.querySelector('[data-testid="workspace-source"]');if(!button)throw new Error('Source absent');button.click();return {clicked:true};`,
        );
        await until(
          () =>
            evaluate(
              `return Boolean(${viewRoot}?.querySelector('native-workspace')?.shadowRoot?.querySelector('code-viewer .view-lines')?.textContent.replace(/\\s+/g,' ').includes('Hello from Farmslot'));`,
            ),
          'rendered Monaco source',
        );
        const geometry = await evaluate(
          `const rect=${viewRoot}?.querySelector('[data-testid="native-send"]')?.getBoundingClientRect();return rect?{top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height,viewport:innerHeight}:null;`,
        );
        assert.ok(
          geometry?.width > 0 &&
            geometry.height > 0 &&
            geometry.top >= 0 &&
            geometry.bottom <= geometry.viewport,
          'Send is outside the default drawer viewport',
        );
        check('rendered-diff-source-and-visible-composer', {
          screenshot: await screenshot('workspace'),
        });
        const workspaceRoot = `${viewRoot}?.querySelector('native-workspace')?.shadowRoot`;
        await evaluate(
          `Array.from(${workspaceRoot}?.querySelectorAll('[role="tab"]')??[]).find(button=>button.textContent.trim()==='Files').click();return true;`,
        );
        await until(
          () =>
            evaluate(`const root=${workspaceRoot};
          if(root?.querySelector('[data-path="README.md"]') && root.querySelector('[data-path="src"]'))return true;
          Array.from(root?.querySelectorAll('button')??[]).find(button=>button.textContent.trim()==='Parent directory')?.click();return false;`),
          'fixture root directory',
        );
        await evaluate(
          `${workspaceRoot}.querySelector('[data-path="README.md"]').click();return true;`,
        );
        const readme = fs
          .readFileSync(path.join(fixture, 'README.md'), 'utf8')
          .replace(/\s+/g, ' ')
          .trim();
        await until(
          () =>
            evaluate(
              `return Array.from(${workspaceRoot}?.querySelectorAll('code-viewer .view-line')??[]).map(line=>line.textContent).join(' ').replace(/\\s+/g,' ').trim().includes(${JSON.stringify(readme)});`,
            ),
          'root file preview',
        );
        await evaluate(`${workspaceRoot}.querySelector('[data-path="src"]').click();return true;`);
        await until(
          () =>
            evaluate(
              `return Boolean(${workspaceRoot}?.querySelector('[data-path="src/greeting.ts"]'));`,
            ),
          'child directory listing',
        );
        assert.equal(
          await evaluate(
            `return Boolean(${workspaceRoot}?.querySelector('.viewer code-viewer, .viewer diff-review'));`,
          ),
          false,
          'Directory descent retained the previous file preview',
        );
        await evaluate(
          `${workspaceRoot}.querySelector('[data-path="src/greeting.ts"]').click();return true;`,
        );
        await until(
          () =>
            evaluate(
              `return ${workspaceRoot}?.querySelector('code-viewer .view-lines')?.textContent.replace(/\\s+/g,' ').includes('Hello from Farmslot')??false;`,
            ),
          'child file preview',
        );
        check('directory-navigation-clears-previous-preview-and-opens-child-file');
        const response = await evaluate(
          `return Array.from(${viewRoot}?.querySelectorAll('article.assistant')??[]).map(item=>item.textContent.trim()).join('\\n');`,
        );
        assert.ok(response, 'Assistant response absent before refresh');
        await reload();
        await assertSelected();
        const count = await until(
          () =>
            evaluate(
              `return Array.from(${viewRoot}?.querySelectorAll('article.user')??[]).filter(item=>item.textContent.includes(${JSON.stringify(state.commands.edit.text)})).length;`,
            ),
          'restored prompt',
        );
        assert.equal(count, 1, 'Refresh duplicated or lost the user prompt');
        await until(
          () =>
            evaluate(
              `return Array.from(${viewRoot}?.querySelectorAll('article.assistant')??[]).map(item=>item.textContent.trim()).join('\\n')===${JSON.stringify(response)};`,
            ),
          'same assistant response after refresh',
        );
        check('refresh-preserves-one-prompt-and-response');
      } else if (stage === 'presentation') {
        assert.equal((await read()).session.state, 'idle');
        const panel = () =>
          evaluate(
            `const p=document.querySelector('chat-panel');return {height:p.querySelector('.cp-drawer').getBoundingClientRect().height,title:p.querySelector('.cp-title').textContent};`,
          );
        const before = await panel();
        await evaluate(
          `document.querySelector('[data-testid="copilot-terminal-mode"]').click();return true;`,
        );
        const terminal = await panel();
        await evaluate(
          `document.querySelector('[data-testid="copilot-workspace-mode"]').click();return true;`,
        );
        await selectSaved();
        const workspace = await panel();
        assert.deepEqual(
          terminal,
          before,
          'Switching experience changed the title or drawer height',
        );
        assert.deepEqual(
          workspace,
          before,
          'Returning to workspace changed the title or drawer height',
        );
        const color = await until(
          () =>
            evaluate(
              `const status=${viewRoot}?.querySelector('.status[data-state="idle"]');return status?getComputedStyle(status).color:false;`,
            ),
          'idle status',
        );
        assert.equal(color, 'rgb(0, 255, 136)', 'Healthy idle status uses warning color');
        await click('[data-testid="native-workspace-toggle"]');
        const w = `${viewRoot}?.querySelector('native-workspace')?.shadowRoot`;
        await evaluate(
          `Array.from(${w}.querySelectorAll('[role="tab"]')).find(b=>b.textContent.trim()==='Files').click();return true;`,
        );
        await until(
          () =>
            evaluate(
              `const root=${w};if(root?.querySelector('[data-path="README.md"]'))return true;Array.from(root?.querySelectorAll('button')??[]).find(b=>b.textContent.trim()==='Parent directory')?.click();return false;`,
            ),
          'unchanged fixture file',
        );
        await evaluate(`${w}.querySelector('[data-path="README.md"]').click();return true;`);
        await until(
          () => evaluate(`return Boolean(${w}?.querySelector('[data-testid="workspace-diff"]'));`),
          'Diff control',
        );
        await evaluate(`${w}.querySelector('[data-testid="workspace-diff"]').click();return true;`);
        await until(
          () =>
            evaluate(
              `return ${w}?.querySelector('.viewer .empty')?.textContent.includes('No changes against HEAD for this file.')??false;`,
            ),
          'explicit unchanged-file message',
        );
        check('mode-switch-preserves-height-title-and-renders-idle-and-unchanged-file-states', {
          color,
          screenshot: await screenshot('presentation'),
        });
      } else if (stage === 'changes-limit') {
        const directory = fs.mkdtempSync(path.join(fixture, 'changes-limit-'));
        try {
          for (let index = 0; index < 502; index++)
            fs.writeFileSync(
              path.join(directory, `${String(index).padStart(4, '0')}.txt`),
              'fixture\n',
            );
          await evaluate(
            `if(!${viewRoot}?.querySelector('native-workspace'))${viewRoot}.querySelector('[data-testid="native-workspace-toggle"]').click();return true;`,
          );
          const w = `${viewRoot}?.querySelector('native-workspace')?.shadowRoot`;
          await evaluate(
            `Array.from(${w}.querySelectorAll('[role="tab"]')).find(b=>b.textContent.trim()==='Changes').click();return true;`,
          );
          await until(
            () =>
              evaluate(
                `const notice=Array.from(${w}?.querySelectorAll('.scope')??[]).find(e=>e.textContent.includes('First 500 changed files shown'));if(!notice)return false;notice.scrollIntoView({block:'nearest'});return true;`,
              ),
            'visible change-list limit',
          );
          const changes = await rpc('native.session.workspace.changes', {
            sessionId: state.sessionId,
          });
          assert.equal(changes.files.length, 500);
          assert.equal(changes.truncated, true);
          check('large-workspace-list-exposes-cap-in-rpc-and-ui', {
            screenshot: await screenshot('changes-limit'),
          });
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      } else if (stage === 'reservation') {
        assert.ok(process.env.FARMSLOT_NATIVE_STATE_DIR, 'Set the isolated native state directory');
        const nativeRoot = fs.realpathSync(process.env.FARMSLOT_NATIVE_STATE_DIR);
        inside(nativeRoot);
        await sendOnce('reservation', 'Reply exactly RESERVED. Do not use tools.');
        assert.equal((await finish('reservation'))?.status, 'completed');
        const snapshot = await read();
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(nativeRoot, 'ready.json'), 'utf8')).pid,
          snapshot.session.hostPid,
        );
        const journal = fs
          .readFileSync(path.join(nativeRoot, 'sessions', `${state.sessionId}.journal`), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const id = state.commands.reservation.id;
        const entry = journal.find(
          (item) => item.event?.type === 'command.submitted' && item.event.commandId === id,
        );
        const command = entry?.commands?.find((item) => item.commandId === id);
        assert.equal(
          command?.state,
          'unknown',
          'Prompt and uncertainty were not reserved atomically',
        );
        assert.equal(command.submitted, true);
        assert.ok(
          !journal.some((item) =>
            item.commands?.some(
              (command) => command.commandId === id && command.state === 'pending',
            ),
          ),
          'Redundant pending-command journal write',
        );
        check('real-ui-command-reserves-prompt-and-uncertainty-in-one-journal-append', {
          commandId: id,
        });
      } else if (stage === 'layout') {
        const original = await evaluate('return {width:innerWidth,height:innerHeight};');
        try {
          for (const width of [500, 1440]) {
            await cdp('viewport', route, String(width), '844');
            await until(
              () => evaluate(`return innerWidth===${width} && innerHeight===844;`),
              'browser resize',
            );
            for (const expanded of [false, true]) {
              await evaluate(`const panel=document.querySelector('chat-panel');
                const drawer=panel.querySelector('.cp-drawer');
                if(drawer.classList.contains('fullscreen')!==${expanded}){
                  const button=Array.from(panel.querySelectorAll('.cp-header button')).find(item=>item.textContent.trim()===${JSON.stringify(expanded ? 'Expand' : 'Restore size')});
                  if(!button)throw new Error('Resize control absent');button.click();
                }return true;`);
              if ((await observe()).identity) {
                const workspace = await evaluate(
                  `return Boolean(${viewRoot}?.querySelector('native-workspace'));`,
                );
                if (workspace) await click('[data-testid="native-workspace-toggle"]');
              }
              await evaluate(
                `${viewRoot}?.querySelector('[data-testid="native-send"]')?.scrollIntoView({block:'nearest'}); return true;`,
              );
              const geometry = await until(
                () =>
                  evaluate(`const button=${viewRoot}?.querySelector('[data-testid="native-send"]');
                const r=button?.getBoundingClientRect();
                return r?.width>0 && r.height>0 && r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth
                  ? {top:r.top,bottom:r.bottom,left:r.left,right:r.right}:false;`),
                'visible composer in resized conversation',
              );
              await click('[data-testid="native-workspace-toggle"]');
              const workspaceGeometry = await until(
                () =>
                  evaluate(`const r=${viewRoot}?.querySelector('native-workspace')?.getBoundingClientRect();
                return r?.width>0 && r.height>0 && r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight
                  ? {top:r.top,bottom:r.bottom,left:r.left,right:r.right}:false;`),
                'visible workspace in resized drawer',
              );
              check('responsive-conversation-and-workspace-controls', {
                width,
                expanded,
                geometry,
                workspaceGeometry,
                screenshot: await screenshot(`layout-${width}-${expanded ? 'expanded' : 'drawer'}`),
              });
            }
          }
        } finally {
          await cdp('viewport', route, String(original.width), String(original.height));
          await evaluate(`const panel=document.querySelector('chat-panel');
            const button=Array.from(panel.querySelectorAll('.cp-header button')).find(item=>item.textContent.trim()==='Restore size');
            button?.click();return true;`);
        }
      } else if (['request-approval', 'deny', 'approve'].includes(stage)) {
        const approvalCase = process.env.FARMSLOT_NATIVE_UI_APPROVAL_CASE ?? 'deny';
        assert.ok(['deny', 'approve'].includes(approvalCase));
        const key = `approval-${approvalCase}`;
        const proof = path.join(fixture, 'approval-proof.txt');
        const expectedCommand = `printf '%s\\n' '${state.marker}' > approval-proof.txt`;
        if (stage === 'request-approval') {
          if (!state.commands[key])
            assert.equal(
              fs.existsSync(proof),
              false,
              'Approval proof file must be absent before this task',
            );
          await sendOnce(
            key,
            `Use only the Bash/shell tool for the command below in the current workspace. Request permission and wait. Do not use file-edit tools or an alternate command if denied. After the decision, stop and report the outcome.\n\nCommand: ${expectedCommand}`,
          );
          const pending = await until(async () => {
            const snapshot = await read();
            return snapshot.pendingRequests.find(
              (event) =>
                event.commandId === state.commands[key].id && event.type === 'approval.requested',
            );
          }, 'approval request');
          state.commands[key].requestId = pending.request.id;
          save();
          await until(
            async () => (await observe()).requests.some((item) => item.id === pending.request.id),
            'rendered approval',
          );
          if (pending.request.detail !== expectedCommand) {
            report.pending = true;
            report.next =
              'The normalized request does not expose the exact proof command. Inspect it explicitly; this scenario will not approve an unverified action.';
          } else check('approval-awaits-explicit-ui-decision', { requestId: pending.request.id });
        } else {
          assert.equal(stage, approvalCase, 'Choose the matching approval case');
          const command = state.commands[key];
          assert.ok(command?.requestId, 'Run request-approval first');
          if (!command.decisionAttempted) {
            await reload();
            const ui = await assertSelected();
            assert.ok(
              ui.requests.some((request) => request.id === command.requestId),
              'Refresh changed pending request identity',
            );
            assert.ok(
              (await read()).pendingRequests.some(
                (event) => event.request?.id === command.requestId,
              ),
              'Gateway request differs from UI',
            );
            const pending = (await read()).pendingRequests.find(
              (event) => event.request?.id === command.requestId,
            );
            assert.equal(
              pending?.request?.detail,
              expectedCommand,
              'Pending action differs from the exact bounded proof command',
            );
            command.decisionAttempted = stage;
            save();
            await click(`[data-request-id="${command.requestId}"] [data-testid="native-${stage}"]`);
          }
          const completed = await finish(key);
          if (completed) {
            if (stage === 'deny')
              assert.equal(fs.existsSync(proof), false, 'Denied operation wrote its file');
            else {
              assert.equal(completed.status, 'completed');
              assert.equal(fs.readFileSync(proof, 'utf8').trim(), state.marker);
            }
            const afterDecision = await read();
            assert.ok(
              afterDecision.events.some(
                (event) =>
                  event.type === 'approval.resolved' && event.request?.id === command.requestId,
              ),
              'Native decision acknowledgement is absent',
            );
            assert.equal(
              afterDecision.pendingRequests.some(
                (event) => event.request?.id === command.requestId,
              ),
              false,
            );
            check('refreshed-approval-decision-has-expected-effect', { decision: stage });
          }
        }
      } else if (stage === 'interrupt' || stage === 'stop') {
        if (stage === 'interrupt')
          await sendOnce(
            'interrupt',
            'Use the Bash/shell tool to run sleep 45 in this workspace. Do not edit files. Wait for the tool; do not return early or start other tools.',
          );
        const snapshot = await until(async () => {
          const current = await read();
          const command = await reconcileCommand('interrupt', current);
          return current.pendingRequests.length ||
            current.events.some(
              (event) => event.commandId === command.id && event.type === 'tool.started',
            )
            ? current
            : false;
        }, 'running tool or approval');
        if (snapshot.pendingRequests.length) {
          report.pending = true;
          report.next = 'Inspect and answer the sleep request explicitly, then run stop.';
        } else {
          const prior = snapshot.events.find(
            (event) =>
              event.commandId === state.commands.interrupt.id && event.type === 'turn.completed',
          );
          if (!prior) {
            assert.ok(
              ['running', 'waiting'].includes(snapshot.session.state),
              'Sleep finished before interruption',
            );
            if (!state.commands.interrupt.stopAttempted) {
              state.commands.interrupt.stopAttempted = true;
              save();
              await click('[data-testid="native-stop"]');
            }
          }
          const completed = await finish('interrupt');
          assert.equal(completed?.status, 'interrupted');
          await assertSelected();
          assert.equal((await read()).session.state, 'idle');
          check('ui-stop-interrupted-the-same-session');
        }
      } else if (stage === 'context-question') {
        const snapshot = await read();
        assert.ok(
          snapshot.session.capabilities.questions,
          'Runner does not support native questions',
        );
        assert.ok(snapshot.session.capabilities.resume, 'This runner version cannot safely resume');
        if (!state.context) {
          state.context = {
            label: `TOOL_CONTEXT_${randomUUID()}`,
            generation: snapshot.session.generation,
            nativeSessionId: snapshot.session.nativeSessionId,
          };
          save();
        }
        await sendOnce(
          'context-question',
          'Use your native user-question tool to ask me for a recovery label. Offer Alpha and Beta and allow a custom answer. After I answer, reply Saved without repeating the label. Do not read or write files or use shell tools.',
        );
        const pending = await until(async () => {
          const current = await read();
          return current.pendingRequests.find(
            (event) =>
              event.commandId === state.commands['context-question'].id &&
              event.type === 'question.requested',
          );
        }, 'native question');
        assert.equal(pending.request.questions?.length, 1, 'Expected one recovery-label question');
        state.context.requestId = pending.request.id;
        save();
        check('native-question-awaits-custom-answer', { requestId: pending.request.id });
      } else if (stage === 'context-answer') {
        assert.ok(state.context?.requestId, 'Run context-question first');
        if (!state.context.answerAttempted) {
          await reload();
          const snapshot = await read();
          assert.ok(
            snapshot.pendingRequests.some((event) => event.request?.id === state.context.requestId),
            'Refresh lost the question',
          );
          const selector = `[data-request-id="${state.context.requestId}"]`;
          await cdp(
            'fill',
            route,
            `${viewSelector}${selector} input[type="text"]`,
            state.context.label,
          );
          state.context.answerAttempted = true;
          save();
          await click(`${selector} button[type="submit"]`);
        }
        assert.equal((await finish('context-question'))?.status, 'completed');
        const snapshot = await read();
        assert.ok(
          !snapshot.events.some(
            (event) =>
              ['command.submitted', 'command.accepted'].includes(event.type) &&
              event.text?.includes(state.context.label),
          ),
          'Recovery label leaked into a user prompt',
        );
        check('custom-answer-sent-only-through-question-response');
      } else if (stage === 'context-fail') {
        assert.ok(state.context?.answerAttempted, 'Run context-answer first');
        if (!state.context.task) {
          const helper = path.join(fixture, `context-wait-${randomUUID()}.cjs`);
          const begin = `${helper}.begin`;
          const effect = `${helper}.effect`;
          fs.writeFileSync(
            helper,
            `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(begin)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(effect)},'completed'),180000);`,
          );
          state.context.task = { helper, begin, effect };
          save();
        }
        const task = state.context.task;
        if (!state.context.crashAttempted) {
          await sendOnce(
            'context-tool',
            `This is an authorized process-lifetime test. Run the bounded local script ${task.helper} once with Node and wait for it to finish. It writes only its PID marker, waits three minutes, then writes a completion marker. The test controller will kill this agent to check cleanup. Do not run it again after interruption.`,
          );
          const snapshot = await until(async () => {
            const current = await read();
            return current.pendingRequests.length || fs.existsSync(task.begin) ? current : false;
          }, 'bounded tool or approval');
          if (snapshot.pendingRequests.length) {
            report.pending = true;
            report.next =
              'Inspect and approve the bounded script through the UI, then rerun context-fail.';
          } else {
            assert.equal(snapshot.session.generation, state.context.generation);
            assert.ok(
              snapshot.events.some(
                (event) =>
                  event.commandId === state.commands['context-tool'].id &&
                  event.type === 'tool.started',
              ),
            );
            assert.equal(fs.existsSync(task.effect), false, 'Bounded tool finished before failure');
            const { stdout } = await exec('ps', ['-axo', 'pid=,ppid='], { timeout: 1000 });
            const children = stdout
              .trim()
              .split('\n')
              .map((line) => line.trim().split(/\s+/).map(Number))
              .filter(([, parent]) => parent === snapshot.session.processPid);
            assert.equal(children.length, 1, 'Expected one native binary under the owned wrapper');
            const current = await read();
            assert.equal(current.session.processPid, snapshot.session.processPid);
            assert.equal(current.session.generation, snapshot.session.generation);
            assert.equal(current.session.processStopped, false);
            state.context.crashAttempted = true;
            save();
            process.kill(children[0][0], 'SIGKILL');
          }
        }
        if (state.context.crashAttempted) {
          await until(async () => {
            const snapshot = await read();
            return snapshot.session.processStopped && snapshot.session.state === 'failed';
          }, 'failed session with confirmed process cleanup');
          assert.equal(fs.existsSync(task.effect), false);
          check('native-process-failure-during-tool-without-completion-effect');
        }
      } else if (stage === 'context-resume') {
        assert.ok(state.context?.answerAttempted, 'Run context-answer first');
        let snapshot = await read();
        if (snapshot.session.generation === state.context.generation) {
          assert.ok(
            snapshot.session.processStopped &&
              ['closed', 'failed'].includes(snapshot.session.state),
            'Stop the owned native process during a bounded tool, verify cleanup, then run context-resume',
          );
          assert.ok(
            snapshot.session.capabilities.resume,
            snapshot.session.capabilities.resumeUnavailableReason,
          );
          await click('[data-testid="native-resume"]');
          snapshot = await until(async () => {
            const current = await read();
            return current.session.generation !== state.context.generation &&
              current.session.state === 'idle'
              ? current
              : false;
          }, 'new native process generation');
        }
        assert.equal(snapshot.session.nativeSessionId, state.context.nativeSessionId);
        assert.ok(state.context.crashAttempted, 'Run context-fail before recovery');
        await sendOnce(
          'context-recall',
          'What exact recovery label did I provide through your question tool earlier? Answer only that label. Do not use tools, read files, or guess.',
        );
        assert.equal((await finish('context-recall'))?.status, 'completed');
        const recovered = await read();
        const response = recovered.events.filter(
          (event) =>
            event.commandId === state.commands['context-recall'].id && event.type === 'text.delta',
        );
        assert.ok(
          response
            .map((event) => event.text ?? '')
            .join('')
            .includes(state.context.label),
          'Resumed native session lost the question-tool answer',
        );
        assert.equal(
          fs.existsSync(state.context.task.effect),
          false,
          'Recovery restarted the interrupted tool',
        );
        assert.ok(
          !recovered.events.some(
            (event) =>
              event.generation === recovered.session.generation && event.type === 'tool.started',
          ),
          'Recovery or recall unexpectedly started a tool',
        );
        const toolPid = Number(fs.readFileSync(state.context.task.begin, 'utf8'));
        assert.ok(Number.isSafeInteger(toolPid) && toolPid > 1);
        assert.throws(
          () => process.kill(toolPid, 0),
          (error) => error.code === 'ESRCH',
          'Interrupted tool process is still alive',
        );
        check('ui-resume-retains-tool-answer-without-prompt-replay', {
          nativeSessionId: recovered.session.nativeSessionId,
          beforeGeneration: state.context.generation,
          afterGeneration: recovered.session.generation,
          screenshot: await screenshot('context-recovered'),
        });
      } else if (stage === 'close') {
        if (!['closed', 'failed'].includes((await read()).session.state))
          await click('[data-testid="native-close"]');
        const snapshot = await until(async () => {
          const current = await read();
          return current.session.processStopped &&
            ['closed', 'failed'].includes(current.session.state)
            ? current
            : false;
        }, 'confirmed process cleanup');
        check('ui-close-confirms-process-stopped', { state: snapshot.session.state });
      }
    }
    report.pass = !report.pending;
  } catch (error) {
    report.error = error.message;
  }
  report.sessionId = state?.sessionId;
  const output = writeEvidence(
    report,
    `${SCENARIO_ID}-${stages.includes(stage) ? stage : 'invalid'}`,
    runner,
    outDir ?? path.join(ROOT, 'temp/native-validation/evidence'),
  );
  return { scenario: SCENARIO_ID, runner, outPath: output, pass: report.pass, report };
}
