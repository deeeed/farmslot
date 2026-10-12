/** Manual browser proof against evidence-review-proof's production RPC and artifact handlers. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { CdpSession, CdpWebPage } from '../packages/recipe-runner/src/runtime/cdp.js';

const stateFile = process.argv[2];
assert(stateFile, 'Pass the isolated proof server state file.');
const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
  gatewayPort: number;
  uiPort: number;
  runs: Array<{ id: string; label: string; recipeRunId: string; claimIds: string[] }>;
};
const port = Number(process.env.FARMSLOT_CDP_PORT);
assert([19222, 19223, 19224].includes(port), 'Use isolated Agent Chrome.');
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = await CdpSession.connect(version.webSocketDebuggerUrl);
const reports = [];
const detail = `document.querySelector('run-detail')`;
const lightbox = `${detail}.shadowRoot.querySelector('media-lightbox')`;
const video = `${lightbox}.shadowRoot.querySelector('video')`;
async function wait<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const until = Date.now() + 15_000;
  let value: T;
  do {
    value = await read();
    if (ready(value)) return value;
    await delay(25);
  } while (Date.now() < until);
  throw new Error(`Review condition timed out: ${JSON.stringify(value!)}`);
}
function requestGateway(method: string, params: Record<string, unknown>) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
      {
        encoding: 'utf8',
        env: { ...process.env, FARMSLOT_GATEWAY: `ws://127.0.0.1:${state.gatewayPort}` },
      },
    ),
  );
}
try {
  for (const run of state.runs.filter((run) => run.label !== 'minimal-author-publish-gate')) {
    const legacyTask =
      run.label === 'legacy-live-ledger'
        ? path.dirname(requestGateway('run.get', { runId: run.id }).run.taskFile)
        : null;
    if (legacyTask)
      execFileSync(process.execPath, [
        'packages/agent-runtime/scripts/acceptance-cli.cjs',
        'set',
        'AC-1',
        'weak',
        '--task-dir',
        legacyTask,
      ]);
    const url = `http://127.0.0.1:${state.uiPort}/#run/${run.id}`;
    const { targetId } = await browser.call<{ targetId: string }>('Target.createTarget', {
      url,
      background: true,
    });
    let page: CdpWebPage | undefined;
    try {
      const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t: { id: string }) => t.id === targetId,
      );
      page = await CdpWebPage.connectToTarget(target);
      const p = page;
      if (run.label === 'failed-recipe-preflight') {
        await wait(
          () => p.evaluate<string>(`${detail}?._selectedRecipeRunId ?? ''`),
          (id) => id === `live-run:${run.recipeRunId}`,
        );
        await p.clickText('Recipe');
        await p.click('[data-testid="recipe-replay-run"]');
        await wait(
          () =>
            p.evaluate<string>(
              `${detail}.shadowRoot.querySelector('ready-workspace')?.querySelector('recipe-output-panel')?.textContent ?? ''`,
            ),
          (text) => text.includes('Fixture preflight failed'),
        );
        await wait(
          () =>
            p.evaluate<{ claims: number; errors: string[]; pending: string }>(
              `({claims:${detail}.evidenceModel?.claims.length ?? 0,errors:${detail}.evidenceModel?.errors ?? [],pending:${detail}._pendingRecipeRunSelectionId})`,
            ),
          (value) => value.claims === run.claimIds.length && !value.errors.length && !value.pending,
        );
        assert.equal(
          await p.evaluate<string>(`${detail}._recordedEvidence.input.claims.recipeRunId`),
          run.recipeRunId,
        );
        reports.push({ runId: run.id, label: run.label, failedPreflightRetainsEvidence: true });
        continue;
      }
      if (run.label === 'live-recipe-rollover') {
        await wait(
          () => p.evaluate<string>(`${detail}?._selectedRecipeRunId ?? ''`),
          (id) => id === `live-run:${run.recipeRunId}`,
        );
        const oldGroup = await p.evaluate<string>(`${detail}._selectedRecipeRunId`);
        await p.clickText('Recipe');
        await p.click('[data-testid="recipe-replay-run"]');
        await wait(
          () =>
            p.evaluate<{ group: string; claims: number; errors: string[] }>(
              `({group:${detail}._selectedRecipeRunId,claims:${detail}.evidenceModel?.claims.length ?? 0,errors:${detail}.evidenceModel?.errors ?? []})`,
            ),
          (value) => value.group !== oldGroup && value.claims > 0 && !value.errors.length,
        );
        reports.push({ runId: run.id, label: run.label, liveGroupRollover: true });
        continue;
      }
      if (run.label === 'qa-multi-case-proof') {
        const result = requestGateway('run.recipeRunsForRun', {
          runId: run.id,
          recipeRunId: 'live-run:previous',
          includeRecordedEvidence: true,
        });
        assert(result.recipeRuns.length > 0);
        assert(result.selectedRecipeRunId);
        assert.equal(result.recordedEvidence.input, undefined);
        assert(result.recordedEvidence.errors.length);
      }
      if (run.label === 'legacy-live-ledger') {
        await wait(
          () => p.evaluate<string>(`${detail}?.evidenceModel?.claims[0]?.status?.verdict ?? ''`),
          (value) => value === 'weak',
        );
        execFileSync(process.execPath, [
          'packages/agent-runtime/scripts/acceptance-cli.cjs',
          'set',
          'AC-1',
          'proven',
          '--task-dir',
          legacyTask!,
          '--proof-mode',
          'state',
          '--recipe-node',
          'check_one',
          '--evidence',
          'artifacts/stills/check_one-1.png',
        ]);
        await wait(
          () => p.evaluate<string>(`${detail}?.evidenceModel?.claims[0]?.status?.verdict ?? ''`),
          (value) => value === 'proven',
        );
        const row = await p.evaluate<string>(
          `${detail}.shadowRoot.querySelector('run-pipeline').shadowRoot.querySelector('[data-ac-id="AC-1"]').textContent`,
        );
        assert(row.includes('proven'));
        reports.push({ runId: run.id, label: run.label, ledgerLiveUpdate: true });
        continue;
      }
      await wait(
        () =>
          p.evaluate<{ count: number }>(
            `({count:${detail}?.shadowRoot?.querySelector('run-pipeline')?.shadowRoot?.querySelectorAll('[data-ac-id]').length ?? 0})`,
          ),
        (value) => value.count === run.claimIds.length,
      );
      const panelOpen = await p.evaluate<boolean>(
        `${detail}.shadowRoot.querySelector('run-pipeline').shadowRoot.querySelector('[data-testid="acceptance-panel"]').open`,
      );
      if (!panelOpen) await p.click('[data-proof-steps] summary');
      const claims = [];
      for (const id of run.claimIds) {
        await p.click(`[data-proof-steps] [data-ac-id="${id}"] [data-testid="acceptance-clip"]`);
        const clips = await wait(
          () =>
            p.evaluate<Array<{ videoPath: string; startMs: number; endMs: number }>>(
              `${detail}.evidenceModel?.selection?.clips ?? []`,
            ),
          (value) => value.length > 0,
        );
        const last = clips.at(-1)!;
        const observed = await wait(
          () =>
            p.evaluate<{
              source: string;
              timeMs: number;
              paused: boolean;
              ready: number;
              error: string;
            }>(
              `(() => {const v=${video};return {source:v?.getAttribute('src') ?? '', timeMs:(v?.currentTime ?? 0)*1000,paused:v?.paused ?? false,ready:v?.readyState ?? 0,error:${lightbox}?.shadowRoot?.querySelector('.ml-count')?.textContent ?? ''}})()`,
            ),
          (value) =>
            decodeURIComponent(value.source).includes(last.videoPath) &&
            value.paused &&
            value.ready >= 2 &&
            Math.abs(value.timeMs - last.endMs) < 50,
        );
        assert.equal(await p.evaluate(`${detail}.evidenceModel.selection.claimId`), id);
        assert.deepEqual(
          await p.evaluate(`${detail}._evidenceLightboxItems.map(i=>i.path)`),
          await p.evaluate(`${lightbox}.items.map(i=>i.path)`),
          'segment transitions keep the parent gallery',
        );
        assert.equal(
          await p.evaluate(`${detail}._evidenceLightboxIndex`),
          await p.evaluate(`${lightbox}.selectedIndex`),
        );
        const markers = await p.evaluate<number>(
          `${lightbox}.shadowRoot.querySelectorAll('[data-testid="video-marker"]').length`,
        );
        assert(markers > 0, 'The player exposes verified action/proof markers.');
        claims.push({
          id,
          clips: clips.length,
          lastOriginal: last.videoPath,
          timeMs: observed.timeMs,
          markerControls: markers,
        });
        if (id === run.claimIds[0]) {
          const shot = await p.session.call<{ data: string }>('Page.captureScreenshot', {
            format: 'png',
          });
          await fs.writeFile(
            path.join(path.dirname(stateFile), `${run.label}.png`),
            Buffer.from(shot.data, 'base64'),
          );
        }
        await p.click('.ml-actions button:last-child');
      }
      // Traverse the real step control, then load the retained report through its normal button.
      const proofIndex = await p.evaluate<number>(
        `${detail}.evidenceModel.claims[0].occurrences[0].traceIndex`,
      );
      await p.click(`[data-testid="recipe-proof-step"][data-trace-index="${proofIndex}"]`);
      await wait(
        () => p.evaluate<boolean>(`${lightbox}.open`),
        (value) => value,
      );
      await p.click('.ml-actions button:last-child');
      await p.click('[data-testid="output-review-gate"] .evidence-link');
      await wait(
        () => p.evaluate<string>(`${lightbox}?.shadowRoot?.textContent ?? ''`),
        (value) => value.includes('Report snapshot') && value.includes('Recipe output'),
      );
      const report = await p.evaluate<string>(`${lightbox}.shadowRoot.textContent`);
      assert(report.includes(run.claimIds[0]!));
      // Scope to the open player; the page also contains acceptance panels.
      const clickPlayer = async (selector: string) => {
        const point = await p.evaluate<{ x: number; y: number }>(
          `(()=>{const el=${lightbox}.shadowRoot.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        await p.clickPoint(point.x, point.y);
      };
      const panelOpenInReport = await p.evaluate<boolean>(
        `${lightbox}.shadowRoot.querySelector('[data-testid="acceptance-panel"]').open`,
      );
      if (!panelOpenInReport) await clickPlayer('[data-testid="acceptance-panel"] summary');
      await wait(
        () =>
          p.evaluate<boolean>(
            `${lightbox}.shadowRoot.querySelector('[data-testid="acceptance-panel"]').open`,
          ),
        (value) => value,
      );
      await clickPlayer(`[data-ac-id="${run.claimIds[0]}"] [data-testid="acceptance-clip"]`);
      await wait(
        () => p.evaluate<number>(`${lightbox}.selectedIndex`),
        (value) => value > 0,
      );
      assert.equal(
        await p.evaluate(`${detail}._evidenceLightboxIndex`),
        await p.evaluate(`${lightbox}.selectedIndex`),
      );
      await p.click('.ml-film-item:first-child');
      await wait(
        () => p.evaluate<string>(`${lightbox}.shadowRoot.textContent`),
        (value) => value.includes('Recipe output'),
      );
      assert.equal(await p.evaluate(`${lightbox}.selectedIndex`), 0);
      reports.push({
        runId: run.id,
        label: run.label,
        claims,
        reportSnapshot: true,
        stepTraversal: true,
        reportClipReturn: true,
      });
    } finally {
      page?.session.close();
      await browser.call('Target.closeTarget', { targetId });
    }
  }
  const readyRun = state.runs.find((run) => run.label === 'minimal-author-publish-gate');
  if (readyRun) {
    const url = `http://127.0.0.1:${state.uiPort}/#run/${readyRun.id}`;
    const { targetId } = await browser.call<{ targetId: string }>('Target.createTarget', {
      url,
      background: true,
    });
    let page: CdpWebPage | undefined;
    try {
      const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t: { id: string }) => t.id === targetId,
      );
      page = await CdpWebPage.connectToTarget(target);
      const p = page;
      const workspace = `${detail}?.shadowRoot?.querySelector('ready-workspace')`;
      await wait(
        () => p.evaluate<number>(`${workspace}?._evidenceModel?.claims.length ?? 0`),
        (n) => n === 2,
      );
      if (
        !(await p.evaluate<boolean>(
          `${workspace}.querySelector('[data-testid="acceptance-panel"]').open`,
        ))
      )
        await p.click('ready-workspace [data-testid="acceptance-panel"] summary');
      await p.click('ready-workspace [data-ac-id="AC-1"] [data-testid="acceptance-clip"]');
      const player = `${workspace}.querySelector('media-lightbox').shadowRoot.querySelector('video')`;
      await wait(
        () =>
          p.evaluate<boolean>(
            `(()=>{const v=${player};return !!v && v.readyState >= 2 && v.paused && Math.abs(v.currentTime-v.duration)<0.05})()`,
          ),
        (value) => value,
      );
      assert.deepEqual(await p.evaluate(`${workspace}._evidenceModel.errors`), []);
      assert.equal(await p.evaluate(`${workspace}._evidenceModel.selection.claimId`), 'AC-1');
      const shot = await p.session.call<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
      });
      await fs.writeFile(
        path.join(path.dirname(stateFile), 'frozen-ready-player.png'),
        Buffer.from(shot.data, 'base64'),
      );
      reports.push({
        runId: readyRun.id,
        label: readyRun.label,
        claims: [
          {
            id: 'AC-1',
            clips: 1,
            lastOriginal: 'videos/recipe-run.mp4',
            timeMs: await p.evaluate<number>(`${player}.currentTime*1000`),
            markerControls: await p.evaluate<number>(
              `${workspace}.querySelector('media-lightbox').shadowRoot.querySelectorAll('[data-testid="video-marker"]').length`,
            ),
          },
        ],
        reportSnapshot: false,
        stepTraversal: false,
      });
    } finally {
      page?.session.close();
      await browser.call('Target.closeTarget', { targetId });
    }
  }
  const receipt = {
    pass: true,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    productionRPC: true,
    realRetainedPackages: true,
    backgroundTargets: true,
    reports,
  };
  await fs.writeFile(
    path.join(path.dirname(stateFile), 'browser-receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
  console.log(
    JSON.stringify({
      pass: true,
      runs: reports.length,
      claims: reports.reduce((sum, run) => sum + (run.claims?.length ?? 0), 0),
    }),
  );
} finally {
  browser.close();
}
