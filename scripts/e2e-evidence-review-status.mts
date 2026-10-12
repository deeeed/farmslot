/** Manual, read-only UI regression proof against retained runs on a connected gateway. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { CdpSession, CdpWebPage } from '../packages/recipe-runner/src/runtime/cdp.js';

const config = JSON.parse(await fs.readFile(process.argv[2]!, 'utf8')) as {
  uiUrl: string;
  legacyRunId: string;
  reportRunId: string;
  outputDir: string;
  mode: 'before' | 'after';
};
const port = Number(process.env.FARMSLOT_CDP_PORT);
assert([19222, 19223, 19224].includes(port), 'Use isolated Agent Chrome.');
await fs.mkdir(config.outputDir, { recursive: true });
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = await CdpSession.connect(version.webSocketDebuggerUrl);
const detail = `document.querySelector('run-detail')`;
const panel = `${detail}.shadowRoot.querySelector('run-pipeline').shadowRoot`;
const receipts = [];
async function wait<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 10_000;
  let value: T;
  do {
    value = await read();
    if (ready(value)) return value;
    await delay(25);
  } while (Date.now() < until);
  throw new Error(`Review condition timed out: ${JSON.stringify(value!)}`);
}
try {
  for (const [kind, runId] of [
    ['legacy', config.legacyRunId],
    ['report', config.reportRunId],
  ]) {
    const { targetId } = await browser.call<{ targetId: string }>('Target.createTarget', {
      url: `${config.uiUrl}/#run/${runId}`,
      background: true,
    });
    let page: CdpWebPage | undefined;
    try {
      const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (entry: { id: string }) => entry.id === targetId,
      );
      page = await CdpWebPage.connectToTarget(target);
      const p = page;
      await wait(
        () =>
          p.evaluate<boolean>(
            `${detail}?.run?.id === ${JSON.stringify(runId)} && !!${detail}.evidenceModel`,
          ),
        Boolean,
      );
      if (kind === 'legacy') {
        await p.waitForSelector('.ac-panel');
        await wait(
          () =>
            p.evaluate<boolean>(
              `${detail}.evidenceModel.errors.some((error) => error.includes('summary.json'))`,
            ),
          Boolean,
        );
        if (config.mode === 'after') {
          const status = await p.evaluate<{ status: string; issues: unknown[]; tone: string }>(
            `${detail}.evidenceModel.packageStatus`,
          );
          assert.equal(status.status, 'Legacy');
          assert.equal(status.tone, 'info');
          assert(status.issues.length >= 3);
          assert.equal(
            await p.evaluate(
              `${panel}.querySelector('[data-testid="evidence-package-details"]').open`,
            ),
            false,
          );
          await p.click('[data-testid="evidence-package-details"] summary');
          assert.equal(
            await p.evaluate(
              `${panel}.querySelector('[data-testid="evidence-package-details"]').open`,
            ),
            true,
          );
          await p.click('[data-testid="evidence-package-details"] summary');
          receipts.push({ kind, runId, status, detailsToggle: true });
        } else {
          const errors = await p.evaluate<string[]>(`${detail}.evidenceModel.errors`);
          assert(errors.filter((error) => error.includes('summary.json')).length > 2);
          receipts.push({ kind, runId, errors });
        }
        await p.evaluate(`${panel}.querySelector('.ac-panel').scrollIntoView({block:'center'})`);
      } else {
        await wait(
          () =>
            p.evaluate<boolean>(
              `!!${detail}.evidenceModel.report && ${detail}.evidenceModel.errors.length > 0`,
            ),
          Boolean,
        );
        await p.click('[data-testid="output-review-gate"] a.evidence-link');
        if (config.mode === 'before') {
          const error = await wait(
            () => p.evaluate<{ reason: string } | null>(`${detail}._evidenceArtifactUnavailable`),
            Boolean,
          );
          assert.match(error!.reason, /Select a retained recipe execution/);
          receipts.push({ kind, runId, error });
        } else {
          await wait(() => p.evaluate<boolean>(`${detail}._evidenceLightboxOpen`), Boolean);
          const item = await p.evaluate<{ path: string; verifiedText: string }>(
            `${detail}._evidenceLightboxItems[0]`,
          );
          assert.equal(item.path, 'artifacts/report.html');
          assert(item.verifiedText.length > 100);
          assert.equal(await p.evaluate(`${detail}._evidenceArtifactUnavailable`), null);
          receipts.push({
            kind,
            runId,
            path: item.path,
            verifiedCharacters: item.verifiedText.length,
            manifestDigest: await p.evaluate(`${detail}.evidenceModel.report.manifestDigest`),
          });
        }
      }
      await p.evaluate(`${detail}.updateComplete`);
      await fs.writeFile(
        path.join(config.outputDir, `${kind}-${config.mode}.png`),
        Buffer.from((await p.screenshot()) as string, 'base64'),
      );
    } finally {
      page?.close();
      await browser.call('Target.closeTarget', { targetId });
    }
  }
  await fs.writeFile(
    path.join(config.outputDir, `${config.mode}.json`),
    JSON.stringify(
      {
        pass: true,
        mode: config.mode,
        liveGateway: true,
        readOnly: true,
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        receipts,
      },
      null,
      2,
    ),
  );
} finally {
  browser.close();
}
