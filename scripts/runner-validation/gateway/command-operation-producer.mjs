// Emit a disposable command observation for the companion gateway/CDP recipe.
import path from 'node:path';

import { OperationRecord } from '../../../packages/recipe-harness/dist/runtime/operation.js';

const [targetArg, taskArg] = process.argv.slice(2);
if (!targetArg || !taskArg)
  throw new Error(
    'Usage: node command-operation-producer.mjs <disposable-checkout> <disposable-task-dir>',
  );
const target = path.resolve(targetArg);
const task = path.resolve(taskArg);
const operation = new OperationRecord(
  path.join(target, 'temp/recipe/runtime/operations'),
  'observation fixture',
  target,
  { mirrorDirectory: path.join(task, 'artifacts/operations') },
);
operation.stage('fixture output');
operation.output('Observation fixture started\n');
console.log(JSON.stringify(operation.value));
let sequence = 0;
const timer = setInterval(
  () => operation.output(`Observation fixture output ${++sequence}\n`),
  1000,
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    clearInterval(timer);
    operation.finish(0);
    process.exit(0);
  });
