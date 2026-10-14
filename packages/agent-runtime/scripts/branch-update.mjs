// The task runtime owns inspection, guarded replay, leased push and result verification.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const compiled = new URL('../dist/task-init/branch-update.js', import.meta.url);
if (!existsSync(fileURLToPath(compiled))) {
  throw new Error('Build the supplying agent runtime before branch maintenance.');
}
const sdk = await import(compiled.href);
const [phase, encoded] = process.argv.slice(2);
try {
  const value = JSON.parse(encoded);
  let result;
  if (phase === 'inspect') result = sdk.inspectBranchMaintenance(value);
  else if (phase === 'execute')
    result =
      value.kind === 'ordinary'
        ? sdk.executeOrdinaryBranchMaintenance(value)
        : sdk.executeBranchMaintenance(value);
  else if (phase === 'push')
    result =
      value.kind === 'ordinary'
        ? sdk.pushOrdinaryBranchMaintenance(value)
        : sdk.pushBranchMaintenance(value);
  else if (phase === 'verify') result = sdk.verifyBranchMaintenance(value);
  else if (phase === 'validate') result = sdk.validateBranchMaintenance(value);
  else if (phase === 'retire')
    result = sdk.retireBranchMaintenance(value.operation ?? value, value.recoverLocal === true);
  else throw new Error('Unknown internal branch-maintenance operation.');
  process.stdout.write(JSON.stringify(result ?? null) + '\n');
} catch (error) {
  if (!(error instanceof sdk.BranchMaintenanceRefusal)) throw error;
  process.stderr.write(JSON.stringify({ code: error.code, message: error.message }) + '\n');
  process.exitCode = 2;
}
