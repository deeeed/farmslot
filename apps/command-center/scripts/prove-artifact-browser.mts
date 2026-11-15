// A real retained run, authenticated RPC, and actual browser controls. No seeded UI state.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { collectRunEvidenceArtifacts } from '../ui/src/components/runs/run-utils.js';
import {
  workspaceArtifactBasename,
  workspaceArtifactType,
  workspaceArtifactTypeLabel,
} from '../ui/src/components/workspace/workspace-artifacts.js';
import { GatewayClient } from '../../../packages/cli/src/gateway-client.js';
import type { RunGetResult } from '../../../packages/protocol/src/rpc/run.js';
import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const output = process.env.FARMSLOT_ARTIFACT_PROOF_OUTPUT;
const runId = process.env.FARMSLOT_ARTIFACT_PROOF_RUN_ID;
const tab = process.env.FARMSLOT_ARTIFACT_PROOF_TAB;
assert(
  output && runId && tab,
  'Select output directory, real run UUID and owned connected CDP tab',
);
const target = await automationGatewayTarget();
assert(target, 'Select an explicit automation/test gateway profile');
const client = await new GatewayClient({ ...target, timeout: 30000 }).connect();
const execute = promisify(execFile);
const cdp = async (...args: string[]) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: source, timeout: 40000, maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout,
  );
const selector =
  'run-detail >>> [data-testid="run-artifact-explorer"] step-artifacts >>> artifact-browser >>> ';
const inspect = () =>
  cdp(
    'eval',
    tab,
    '--file',
    path.join(source, 'apps/command-center/scripts/probes/artifact-browser-read.js'),
  );
type Observation = Awaited<ReturnType<typeof inspect>>;
const until = async (check: (state: Observation) => boolean, label: string) => {
  const end = Date.now() + 20000;
  let state;
  do {
    state = await inspect();
    if (check(state)) return state;
    await delay(100);
  } while (Date.now() < end);
  throw new Error(`${label}: ${JSON.stringify(state)}`);
};
try {
  const { run } = await client.call<RunGetResult>('run.get', { runId, view: 'snapshot' });
  const artifacts = collectRunEvidenceArtifacts(run);
  assert(artifacts.length >= 100, 'Select a real run with at least 100 retained artifacts');
  const image = artifacts.find((file) => workspaceArtifactType(file) === 'image');
  const document = artifacts.find((file) => workspaceArtifactType(file) === 'markdown');
  assert(image && document, 'The proof run must contain an image and a Markdown document');
  let state = await inspect();
  assert(
    state.connected && state.runId === runId,
    'Open the selected real run in the owned connected tab',
  );
  if (!state.panelOpen)
    await cdp('click', tab, 'run-detail >>> [data-testid="run-artifacts-toggle"]');
  state = await until((value) => value.paths.length > 0, 'Artifact inventory must load');
  assert(
    !state.modalOpen && state.browserWidth >= 720,
    'Use an unobstructed desktop-width owned tab',
  );
  assert.deepEqual(
    state.paths,
    artifacts.map((file) => file.path),
    'Displayed inventory must match the real run read',
  );
  await mkdir(output, { recursive: true });
  const receipts = [];
  const save = async (name: string, value: Observation) => {
    receipts.push({ name, ...value });
    await writeFile(path.join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
    });
  };
  const onlyType = async (type: 'image' | 'markdown') => {
    const label = workspaceArtifactTypeLabel(type);
    let current = await inspect();
    for (let index = 0; index < current.chips.length; index++) {
      const chip = current.chips[index];
      if (chip.pressed !== chip.text.startsWith(label))
        await cdp('click', tab, selector + `.chips .chip:nth-child(${index + 1})`);
    }
    return until(
      (value) => value.types.length === 1 && value.types[0] === type,
      'Type filter must select only the requested type',
    );
  };
  await cdp('fill', tab, selector + 'input.search', '');
  state = await onlyType('image');
  assert.equal(
    Number(state.match?.split(' ')[0]),
    artifacts.filter((file) => workspaceArtifactType(file) === 'image').length,
  );
  await save('type-filter', state);
  const needle = workspaceArtifactBasename(image.path);
  await cdp('fill', tab, selector + 'input.search', needle);
  state = await until(
    (value) => value.query === needle && value.files.length > 0,
    'Search must find a retained image',
  );
  assert(state.files.every((file: string) => file.toLowerCase().includes(needle.toLowerCase())));
  await save('search', state);
  await cdp('click', tab, selector + 'a.file');
  state = await until(
    (value) =>
      value.files.includes(value.preview.path) &&
      value.preview.imageWidth > 0 &&
      !value.preview.error,
    'Selected image preview must decode',
  );
  await save('image-preview', state);
  await cdp('screenshot', tab, path.join(output, 'image-preview.png'));
  assert(state.folders.length > 0, 'The real run must have folder grouping');
  if (!state.folders[0].expanded) await cdp('click', tab, selector + 'button.toggle');
  await cdp('click', tab, selector + 'button.toggle');
  state = await until(
    (value) => value.folders[0]?.expanded === false && value.files.length === 0,
    'Collapsing the root folder hides its rows',
  );
  await save('folder-collapsed', state);
  await cdp('click', tab, selector + 'button.toggle');
  await until(
    (value) => value.folders[0]?.expanded === true && value.files.length > 0,
    'Expanding the root restores matching files',
  );
  await onlyType('markdown');
  await cdp('fill', tab, selector + 'input.search', workspaceArtifactBasename(document.path));
  state = await until(
    (value) => value.files.length > 0 && value.query === workspaceArtifactBasename(document.path),
    'Search must find the retained document',
  );
  await cdp('click', tab, selector + 'a.file');
  state = await until(
    (value) =>
      value.files.includes(value.preview.path) &&
      value.preview.markdownChars > 0 &&
      !value.preview.error,
    'Selected Markdown preview must render',
  );
  await save('document-preview', state);
  await cdp('screenshot', tab, path.join(output, 'document-preview.png'));
  const result = {
    status: 'pass',
    runId,
    runStatus: run.status,
    artifactCount: artifacts.length,
    cases: receipts.map((row) => row.name),
    proof:
      'Actual authenticated run.get matched to the displayed inventory; real filter/search/folder/preview interactions; no UI state injection or run writes',
  };
  await writeFile(path.join(output, 'proof.json'), JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(JSON.stringify(result));
} finally {
  client.close();
}
