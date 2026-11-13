// One-shot: replace credential values inlined in stored run records with a
// redaction marker. Dry-run by default; prints record ids, field paths and
// counts, never values. --apply rewrites in place without backups.
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  defaultScrubRoots,
  scrubRunCredentials,
  unsafeScrubRoot,
} from '../services/gateway/src/runs/credential-scrub.js';

const flags = process.argv.slice(2);
let apply = false;
let help = false;
let invalid = false;
const roots: string[] = [];
for (let index = 0; index < flags.length; index += 1) {
  const flag = flags[index]!;
  if (flag === '--apply') apply = true;
  else if (flag === '--help') help = true;
  else if (flag === '--root') roots.push(flags[++index] ?? '');
  else if (flag.startsWith('--root=')) roots.push(flag.slice('--root='.length));
  else invalid = true;
}
invalid ||= roots.some((root) => !root || root.startsWith('--'));
if (help || invalid) {
  console.log(
    'Usage: scrub-run-credentials.mts [--root <dir>]... [--apply]\n' +
      'With --root: only the given roots. Without: the gateway runs dir (live, archive,\n' +
      'quarantine), run archive, run bundle store and the run-archive/ and archive/ in their\n' +
      'data dir, resolved like `farmslot paths` (FARMSLOT_HOME, run bundle retention storeRoot,\n' +
      'FARMSLOT_RUN_ARCHIVE_ROOT).',
  );
  process.exit(invalid ? 2 : 0);
}
for (const root of roots) {
  const refused = unsafeScrubRoot(root);
  if (refused) {
    console.error(`refusing --root ${root}: ${refused}`);
    process.exit(2);
  }
}
if (!roots.length) roots.push(...defaultScrubRoots());
console.log(`${apply ? 'apply' : 'dry run'} roots:`);
for (const root of roots) console.log(`  ${root}${existsSync(root) ? '' : ' (missing)'}`);

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
