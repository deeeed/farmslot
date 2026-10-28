import { readFile } from 'node:fs/promises';

import '../src/projects/read-only-status-process.js';

import { importRetainedAcceptanceLinks } from '../src/tasks/retained-acceptance-links.js';

const [inventoryFile, taskRoot, ...extra] = process.argv.slice(2);
if (!inventoryFile || !taskRoot || extra.length) {
  throw new Error(
    'Usage: tsx services/gateway/scripts/migrate-retained-acceptance-links.ts <verified-inventory.json> <original-task-root>',
  );
}
console.log(
  JSON.stringify(await importRetainedAcceptanceLinks(await readFile(inventoryFile), taskRoot)),
);
