import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const phase = process.argv[2];
assert(['warm', 'cold'].includes(phase));
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
const serial = process.env.ADB_SERIAL;
assert(serial && serial === process.env.FARMSLOT_PROOF_PHYSICAL_SERIAL);
const output = process.env.FARMSLOT_OFFLINE_ROUTE_OUT;
assert(output && path.isAbsolute(output));
const subjects = JSON.parse(await fs.readFile(process.env.FARMSLOT_OFFLINE_ROUTE_SUBJECTS, 'utf8'));
const cases = JSON.parse(
  await fs.readFile(
    new URL('../../../command-center/scripts/agentic/offline-route-cases.json', import.meta.url),
    'utf8',
  ),
);
const proxy = JSON.parse(
  await fs.readFile(process.env.FARMSLOT_OFFLINE_ROUTE_PROXY_RECEIPT, 'utf8'),
);
assert.equal(proxy.offline, phase === 'cold', 'Toggle only the owned proof proxy before the sweep');
const bundle = 'net.siteed.farmslot.development';
const session = 'cx-offline-first';
const cli = fileURLToPath(new URL('../../../../node_modules/.bin/agent-device', import.meta.url));
const device = async (...args) => {
  const { stdout } = await execute(cli, [...args, '--session', session, '--json'], {
    timeout: 45_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const response = JSON.parse(stdout);
  assert(response.success, JSON.stringify(response.error));
  return response.data;
};

// Exact native roots from the existing screens, plus unique headings for screens without IDs.
function target(entry) {
  const tab = /^\(tabs\)\/(.+)\.tsx$/.exec(entry.file)?.[1];
  if (tab === 'roadmap') return { label: 'planning items' };
  if (tab)
    return {
      id: `companion-screen-${tab === 'runs' ? 'review' : tab === 'workers' ? 'terminals' : tab}`,
    };
  if (entry.file === 'index.tsx') return { id: 'companion-screen-review' };
  if (['native.tsx', 'work-graphs.tsx', 'dispatch-queue.tsx'].includes(entry.file))
    return {
      id:
        entry.file === 'native.tsx'
          ? 'companion-screen-native'
          : `companion-${entry.file.slice(0, -4)}`,
    };
  if (['prs.tsx', 'pr-automation.tsx'].includes(entry.file))
    return { id: 'companion-pr-automation' };
  if (entry.file === 'filters.tsx') return { label: 'Workspace filters' };
  if (entry.file === 'run-filters.tsx') return { label: 'Run filters' };
  if (entry.file === 'backlog/create.tsx') return { label: 'New backlog item' };
  if (entry.file.startsWith('backlog/edit/')) return { label: 'Edit backlog item' };
  if (entry.file.startsWith('backlog/')) return { label: subjects.backlogTitle ?? 'Backlog item' };
  if (entry.file.startsWith('roadmap/')) return { label: subjects.roadmapId };
  if (entry.file.startsWith('family/')) return { id: 'companion-screen-family-workspace' };
  if (entry.file.startsWith('visual-review/')) return { id: 'companion-screen-visual-review' };
  if (entry.file.startsWith('gate-review/')) return { id: 'companion-screen-gate-review' };
  if (entry.file.startsWith('decision/') || entry.file.endsWith('/gate.tsx'))
    return { id: 'companion-screen-decision-workspace' };
  if (
    entry.file.startsWith('workspace/slot/') ||
    entry.file.startsWith('slot/') ||
    entry.file.startsWith('diff/slot/')
  )
    return entry.file.includes('diff')
      ? { label: 'Slot diff' }
      : { id: 'companion-screen-slot-workspace' };
  if (
    entry.file.startsWith('artifacts/') ||
    entry.file.startsWith('evidence/') ||
    entry.file.endsWith('/files.tsx')
  )
    return { id: 'companion-screen-run-files' };
  if (entry.file.startsWith('diff/') || entry.file.endsWith('/diff.tsx'))
    return { id: 'companion-screen-run-diff' };
  if (entry.file.startsWith('run/') || entry.file.startsWith('workspace/run/'))
    return { id: 'companion-screen-run-detail' };
  throw new Error(`No route identity assertion for ${entry.file}`);
}
const results = [];
await fs.mkdir(output, { recursive: true });
const opened = await device('open', bundle, '--platform', 'android', '--device', 'Pixel 6');
assert.equal(opened.id ?? opened.serial, serial);
try {
  for (const entry of cases.companion) {
    if (
      ['layout', 'connection', 'development', 'stream'].includes(entry.kind) ||
      entry.href.includes('terminal')
    ) {
      results.push({
        ...entry,
        result: 'NAMED EXCEPTION',
        proofReason: entry.href.includes('terminal')
          ? 'Live terminal opening can resize its pane; requires an owned sandbox rather than the read-only farm.'
          : entry.reason,
      });
      continue;
    }
    try {
      const expected = target(entry);
      const missing = [...entry.href.matchAll(/\{([^}]+)\}/g)]
        .map((match) => match[1])
        .filter((key) => !subjects[key]);
      assert.equal(missing.length, 0, `No live subject for ${missing.join(', ')}`);
      const href = entry.href.replace(/\{([^}]+)\}/g, (_match, key) =>
        encodeURIComponent(subjects[key]),
      );
      if (phase === 'cold')
        await execute('adb', ['-s', serial, 'shell', 'am', 'force-stop', bundle]);
      const tab = /^\(tabs\)\/(.+)\.tsx$/.exec(entry.file)?.[1];
      if (tab && ['fleet', 'prs', 'inbox', 'copilot', 'backlog', 'roadmap'].includes(tab)) {
        await device('open', bundle, 'farmslot-development:///advanced', '--platform', 'android');
        await device('click', 'id="companion-tab-advanced"', '--settle');
        await device('click', `id="companion-advanced-${tab}"`, '--settle');
      } else {
        await device('open', bundle, `farmslot-development://${href}`, '--platform', 'android');
      }
      const deadline = Date.now() + 20_000;
      let snapshot;
      let labels;
      for (;;) {
        snapshot = await device('snapshot');
        labels = snapshot.nodes.map((node) => node.label ?? '').filter(Boolean);
        const correctRoute = expected.id
          ? snapshot.nodes.some((node) => node.identifier === expected.id)
          : labels.some((label) => label.includes(expected.label));
        if (correctRoute && !labels.some((label) => /^Loading(?:\s|…|\.)/.test(label))) break;
        assert(
          Date.now() < deadline,
          `Requested ${entry.file}, expected ${JSON.stringify(expected)}; visible ${labels.join(' | ').slice(0, 1000)}`,
        );
      }
      const stem = `${String(results.length).padStart(2, '0')}-${entry.file.replaceAll(/[^a-zA-Z0-9.-]/g, '_')}`;
      await fs.writeFile(path.join(output, `${stem}.json`), JSON.stringify(snapshot, null, 2));
      await device('screenshot', path.join(output, `${stem}.png`));
      const body = labels.join(' | ');
      assert(
        !/Unmatched Route|Something went wrong|Render Error|Unable to resolve module/i.test(body),
        body,
      );
      if (entry.kind === 'cached')
        assert(
          !/Connect to (?:the )?gateway to|This .* has not been (?:cached|stored)|Nothing stored yet/i.test(
            body,
          ),
          body,
        );
      results.push({
        ...entry,
        href,
        expected,
        labels,
        screenshot: `${stem}.png`,
        result: 'RENDERED',
      });
    } catch (error) {
      results.push({ ...entry, result: 'FAIL', message: String(error.message).slice(0, 1500) });
    }
    await fs.writeFile(
      path.join(output, 'route-results.json'),
      JSON.stringify({ phase, results }, null, 2),
    );
  }
  assert.deepEqual(
    results.filter((entry) => entry.result === 'FAIL').map(({ file }) => file),
    [],
    'Each native route must reach its own saved body',
  );
  console.log(JSON.stringify({ phase, result: 'PASS', routes: results.length }));
} finally {
  await fs.writeFile(
    path.join(output, 'route-results.json'),
    JSON.stringify(
      {
        phase,
        results,
        limits:
          'Native root/heading and accessibility rendering proof. Cold phase restarts the DEV app for every route with only the owned proxy offline. Saved-row and command-authority semantics have separate cache/controller regressions.',
      },
      null,
      2,
    ),
  );
}
