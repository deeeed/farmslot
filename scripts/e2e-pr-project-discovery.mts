import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
const connection = await new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 120000,
}).connect();
const ruleId = process.env.PROJECT_DISCOVERY_RULE_ID;
const projectUrl = process.env.PROJECT_IMPORT_URL;
const backup = process.env.PROJECT_DISCOVERY_BACKUP_FILE;
const resultFile = process.env.PROJECT_DISCOVERY_RESULT_FILE;
assert(
  ruleId && projectUrl && backup && resultFile,
  'Supply disabled rule, Project URL, private backup and result paths',
);
let original;
try {
  const before = await connection.call('prRules.list', {});
  const rule = before.rules.find((x) => x.id === ruleId);
  assert(rule && !rule.enabled);
  original = before.teams.find((x) => x.id === rule.config.teamId);
  assert(original.config.name.startsWith('Source checkpoint validation'));
  await writeFile(backup, JSON.stringify(original), { mode: 0o600 });
  const imported = await connection.call('prRules.projectImport', {
    account: original.config.account,
    url: projectUrl,
  });
  await connection.call('prRules.teamSave', {
    id: original.id,
    revision: original.revision,
    config: { ...original.config, sources: [imported.source] },
  });
  let preview;
  for (let attempt = 0; attempt < 12; attempt++) {
    ({ preview } = await connection.call('prRules.preview', { id: ruleId }));
    console.log(
      JSON.stringify({
        attempt,
        complete: preview.complete,
        rows: preview.items.length,
        progress: preview.sourceProgress,
        errors: preview.sourceErrors,
      }),
    );
    if (preview.complete) break;
    assert(
      preview.sourceProgress?.pendingConnections,
      'Provider error, not a resumable page boundary',
    );
    const at = Date.parse(preview.sourceProgress.nextAttemptAt ?? '');
    if (Number.isFinite(at) && at > Date.now())
      await new Promise((r) => setTimeout(r, Math.min(at - Date.now() + 1000, 60000)));
  }
  assert(preview?.complete, 'Project scan did not finish');
  const repos = [...new Set(preview.items.map((x) => x.subject.pr.repo))];
  assert(repos.length >= 2, 'Expected actual Project view to span at least two repositories');
  const after = await connection.call('prRules.list', {});
  assert.equal(after.intents.length, before.intents.length);
  assert(!after.rules.find((x) => x.id === ruleId).enabled);
  await writeFile(resultFile, JSON.stringify(preview), { mode: 0o600 });
  console.log(
    JSON.stringify({ passed: true, repositories: repos, rows: preview.items.length, noWork: true }),
  );
} finally {
  if (original) {
    const current = await connection.call('prRules.list', {});
    const team = current.teams.find((x) => x.id === original.id);
    await connection.call('prRules.teamSave', {
      id: team.id,
      revision: team.revision,
      config: original.config,
    });
    console.log('Original disabled-rule team configuration restored');
  }
  connection.close();
}
