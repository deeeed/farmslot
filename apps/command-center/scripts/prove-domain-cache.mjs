import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
const fixture = JSON.parse(await readFile(process.env.FARMSLOT_DOMAIN_PROOF_SETUP, 'utf8'));
assert(fixture.setupComplete && fixture.fixtureOnly && !fixture.providerExecutionClaimed);
assert.notEqual(fixture.farm, root);
const artifacts = path.resolve(process.env.FARMSLOT_DOMAIN_PROOF_ARTIFACTS);
await mkdir(artifacts, { recursive: true });
const probe = path.join(root, 'apps/command-center/scripts/probes/offline-domains.js');
const cdpFile = path.join(root, 'apps/command-center/scripts/cdp.mjs');
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(process.execPath, [cdpFile, ...args], {
        timeout: 65000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout,
  );
const rpc = (method, params = {}) => cdp('gateway', method, JSON.stringify(params));
let route;
const evidence = {};
const claims = {};
evidence.sourceReadbacks = {};
async function sourceReadback(file) {
  assert(file.startsWith(`${fixture.farm}/`) || file.startsWith(`${fixture.home}/`));
  const bytes = await readFile(file);
  evidence.sourceReadbacks[file] = {
    bytes: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
async function navigate(hash) {
  route = hash;
  const url = new URL(process.env.FARMSLOT_UI_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.port, process.env.VITE_PORT);
  url.searchParams.set('domain-proof', path.basename(path.dirname(artifacts)));
  url.hash = hash;
  await cdp('goto', url.href);
  await cdp('focus', hash);
}
const inspect = () => cdp('eval', route, '--file', probe);
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await inspect();
    if (check(value)) return value;
    await delay(80);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const screenshot = (name) => cdp('screenshot', route, path.join(artifacts, `${name}.png`));
const revision = (value, method, family) =>
  value.observations?.[method]?.resourceState?.dependencies.find(
    (entry) => entry.key.family === family,
  )?.revision;
async function pr() {
  await navigate(
    'prs?prSection=prs&prScope=monitored&prPane=monitoring&repo=proof%2Foffline-store&pr=1&view=detail&layout=list&prSort=group',
  );
  let warm = await until(
    (v) => v.observations?.['prWatch.list']?.ready && v.pr?.text.includes('Paused'),
    'Mount the actual monitored PR',
  );
  if (!warm.pr.monitorControls.some((b) => b.visible))
    await cdp(
      'click',
      route,
      'pr-board >>> pr-automation-panel >>> [data-testid="pr-monitor-summary"]',
    );
  warm = await until(
    (v) => v.pr?.monitorControls.some((b) => b.visible),
    'Open the actual monitored PR controls',
  );
  assert.equal(warm.principalId, fixture.ownerId);
  const original = warm.observations['prWatch.list'].data.monitors.find(
    (m) => m.id === fixture.monitorId,
  );
  evidence.monitorBefore = warm;
  assert.equal(original.lifecycle, 'paused');
  const committed = await rpc('prWatch.lifecycle', {
    id: original.id,
    revision: original.revision,
    lifecycle: 'active',
  });
  evidence.monitor = await until(
    (v) =>
      v.connectionId === warm.connectionId &&
      v.observations['prWatch.list']?.ready &&
      revision(v, 'prWatch.list', 'pr-automation') >
        revision(warm, 'prWatch.list', 'pr-automation') &&
      v.observations['prWatch.list'].data.monitors.some(
        (m) =>
          m.id === original.id &&
          m.revision === committed.monitor.revision &&
          m.lifecycle === 'active',
      ) &&
      v.pr?.monitorControls.some((b) => b.visible && b.text === 'Pause'),
    'An independent lifecycle writer must update the mounted monitor and actual button without Refresh',
  );
  await screenshot('pr-lifecycle-external');
  await sourceReadback(path.join(fixture.farm, '.pr-monitors.json'));
  claims.prMonitorWriter = true;
  // Follow the actual tab. Its router adds canonical navigation fields to the URL.
  await cdp('click', route, 'pr-board >>> [data-testid="pr-workspace-automation"]');
  route = 'prs';
  const before = await until(
    (v) => v.observations?.['prRules.list']?.ready && v.pr?.text.includes(fixture.ruleName),
    'Mount the actual rule collection',
  );
  evidence.ruleBefore = before;
  const file = path.join(fixture.farm, '.pr-rules.json');
  const bytes = await readFile(file);
  const source = JSON.parse(bytes);
  const rule = source.rules.find((r) => r.id === fixture.ruleId);
  assert(rule);
  const name = `External rule ${randomUUID()}`;
  rule.config.name = name;
  await writeFile(`${file}.proof-tmp`, JSON.stringify(source), { flag: 'wx' });
  await rename(`${file}.proof-tmp`, file);
  evidence.rule = await until(
    (v) =>
      v.connectionId === before.connectionId &&
      v.observations['prRules.list']?.ready &&
      revision(v, 'prRules.list', 'pr-automation') >
        revision(before, 'prRules.list', 'pr-automation') &&
      v.observations['prRules.list'].data.rules.some(
        (r) => r.id === rule.id && r.config.name === name,
      ) &&
      v.pr?.text.includes(name),
    'An atomic external rule file change must update the mounted rule without Refresh',
  );
  await screenshot('pr-rule-external');
  await sourceReadback(file);
  claims.prRuleFileWriter = true;
  await writeFile(file, '{broken');
  evidence.ruleError = await until(
    (v) =>
      v.observations['prRules.list']?.error?.code === 'SOURCE_UNAVAILABLE' &&
      v.pr?.connected === false &&
      v.pr.text.includes(name) &&
      v.pr.text.includes('source is unavailable') &&
      v.pr.ruleControls.some((button) => button.visible) &&
      v.pr.ruleControls.every((button) => button.disabled),
    'Malformed rules must retain stale displayed rules with an error and refuse actions',
  );
  await screenshot('pr-rule-source-error');
  await writeFile(file, JSON.stringify(source));
  evidence.ruleRecovery = await until(
    (v) => v.observations['prRules.list']?.ready && v.pr?.connected && v.pr.text.includes(name),
    'Repaired rules must recover on the same mounted client',
  );
  claims.prSourceErrorRecovery = true;
}
async function assessment() {
  const mountRequestedAt = Date.now();
  evidence.assessmentMountRequestedAt = mountRequestedAt;
  await navigate(`intelligence?tab=assessments&assessment=${fixture.assessmentId}`);
  const warm = await until(
    (v) =>
      v.observations?.['assessment.summary']?.ready &&
      v.assessment?.records?.some((r) => r.id === fixture.assessmentId),
    'Mount the seeded completed assessment through the real history route',
  );
  const record = warm.assessment.records.find((r) => r.id === fixture.assessmentId);
  evidence.feedbackBefore = warm;
  const started = Date.now();
  const committed = await rpc('assessment.feedback', {
    id: record.id,
    expectedRevision: record.feedback.length,
    questionId: 'color',
    verdict: 'correct',
    adviceUsed: false,
    adviceShown: true,
    evidenceRef: 'D07 launch fixture, no provider result claimed',
  });
  evidence.feedback = await until(
    (v) =>
      v.connectionId === warm.connectionId &&
      revision(v, 'assessment.summary', 'assessment') >
        revision(warm, 'assessment.summary', 'assessment') &&
      v.assessment?.records?.some(
        (r) => r.id === record.id && r.feedback.length === committed.feedback.length,
      ) &&
      v.observations['assessment.summary']?.data.correctQuestions >
        warm.observations['assessment.summary'].data.correctQuestions &&
      v.assessment.text.replace(/\s+/g, ' ').includes('1 operator-labeled questions'),
    'Feedback must update the actual mounted history/detail before its retained polling timer',
    7000,
  );
  assert(Date.now() - mountRequestedAt < 15000, 'The retained 15s poll cannot explain this update');
  evidence.feedbackElapsedMs = Date.now() - started;
  await screenshot('assessment-feedback-external');
  await sourceReadback(path.join(fixture.home, 'assessments', `${fixture.assessmentId}.json`));
  claims.assessmentFeedbackWriter = true;
}
async function analytics() {
  await navigate(`analytics?project=${fixture.project}`);
  const warm = await until(
    (v) =>
      v.observations?.['analytics.query']?.ready &&
      v.analytics?.result?.dimensions.projects.includes(fixture.project),
    'Mount the real project-filtered analytics query',
  );
  evidence.analyticsBefore = warm;
  assert(!warm.analytics.result.dimensions.projects.includes(`${fixture.project}-other`));
  const committed = await rpc('analytics.backfill');
  assert(committed.written >= 1);
  evidence.analytics = await until(
    (v) =>
      v.connectionId === warm.connectionId &&
      v.observations['analytics.query']?.ready &&
      revision(v, 'analytics.query', 'analytics') >
        revision(warm, 'analytics.query', 'analytics') &&
      v.analytics?.result?.matchedRuns === warm.analytics.result.matchedRuns &&
      v.analytics.result.scannedRuns > warm.analytics.result.scannedRuns &&
      v.analytics.result.dimensions.projects.includes(`${fixture.project}-other`) &&
      v.analytics.text.includes('runs'),
    'A real other-project backfill must update mounted filtered charts and global dimensions without Refresh',
  );
  await screenshot('analytics-other-project-backfill');
  const directory = path.join(fixture.farm, '.runs/analytics');
  for (const name of await readdir(directory))
    if (/^events-\d{4}-\d{2}\.ndjson$/.test(name)) await sourceReadback(path.join(directory, name));
  claims.analyticsWriter = true;
}
async function copilot() {
  await navigate('analytics');
  await cdp('click', route, 'button[title="Co-Pilot (Cmd+K)"]');
  const warm = await until(
    (v) =>
      v.chat?.open &&
      v.observations?.['copilot.status']?.ready &&
      v.chat?.save.some((b) => b.visible),
    'Open the real stopped copilot configuration',
  );
  assert(['stopped', 'failed'].includes(warm.chat.runtime.status));
  evidence.copilotBefore = warm;
  assert.equal(warm.chat.runtime.autostart, false);
  const effort = warm.chat.runtime.effort === 'high' ? 'low' : 'high';
  const committed = await rpc('copilot.configure', { effort, autostart: false });
  evidence.copilot = await until(
    (v) =>
      v.connectionId === warm.connectionId &&
      v.observations['copilot.status']?.ready &&
      revision(v, 'copilot.status', 'copilot') > revision(warm, 'copilot.status', 'copilot') &&
      v.chat?.runtime.effort === effort &&
      v.observations['copilot.status'].observedAt >= Date.parse(committed.session.updatedAt) &&
      v.chat.effort?.visible &&
      v.chat.effort.value === effort &&
      v.chat.effort.selected.length === 1 &&
      v.chat.effort.selected[0].value === effort &&
      v.chat.effort.selected[0].visible,
    'A real copilot configure writer must update the mounted runtime without launching it',
  );
  assert(['stopped', 'failed'].includes(evidence.copilot.chat.runtime.status));
  await screenshot('copilot-configure-external');
  await sourceReadback(path.join(fixture.home, 'copilot-runtime/session.json'));
  claims.copilotConfigurationWriter = true;
}
let failure;
try {
  await pr();
  await assessment();
  await analytics();
  await copilot();
} catch (error) {
  failure = error;
} finally {
  await writeFile(
    path.join(artifacts, 'domain-proof-receipt.json'),
    JSON.stringify({ fixtureOnly: true, claims, evidence, failure: failure?.message }, null, 2),
  );
}
if (failure) throw failure;
console.log(JSON.stringify(claims));
