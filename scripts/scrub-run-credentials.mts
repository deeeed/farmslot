// One-shot: replace credential values inlined in stored run records with a
// redaction marker. Dry-run by default; prints record ids, field paths and
// counts, never values. --apply rewrites in place without backups.
import path from 'node:path';

import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';

import { scrubRunCredentials } from '../services/gateway/src/runs/credential-scrub.js';

const flags = process.argv.slice(2);
const apply = flags.includes('--apply');
const roots = flags.flatMap((flag, index) => (flag === '--root' ? [flags[index + 1]!] : []));
if (flags.includes('--help') || roots.some((root) => !root)) {
  console.log(
    'Usage: scrub-run-credentials.mts [--root <dir>]... [--apply]\n' +
      'Without --root: the gateway runs dir (live, archive, quarantine), run archive and run bundles.',
  );
  process.exit(roots.some((root) => !root) ? 2 : 0);
}
if (!roots.length) {
  const paths = currentFarmPaths('gateway');
  roots.push(paths.state.runs, paths.data.runArchive, paths.data.runBundles);
}

for (const root of roots) {
  const report = await scrubRunCredentials([root], { apply });
  for (const finding of report.findings)
    console.log(
      `${apply ? 'scrubbed' : 'would scrub'} ${path.basename(finding.file).replace(/\.jsonl?$/u, '')} ` +
        `(${finding.file}): ${finding.values} value(s) in ${finding.fields.join(', ')}`,
    );
  for (const bundle of report.bundles)
    console.log(`not rewritten (archive bundle; re-export or delete): ${bundle}`);
  const values = report.findings.reduce((sum, finding) => sum + finding.values, 0);
  console.log(
    `${apply ? 'applied' : 'dry run'} ${root}: scanned=${report.scanned} ` +
      `records=${report.findings.length} values=${values} bundles=${report.bundles.length}`,
  );
}
