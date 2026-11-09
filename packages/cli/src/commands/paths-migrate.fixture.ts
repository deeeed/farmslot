import { migratePaths, type MigrationOptions } from './paths-migrate.js';
const options: MigrationOptions = JSON.parse(process.argv[2]);
await migratePaths(options, 'apply', {
  checkpoint: async (plan, index) => {
    const step = plan.steps[index];
    if (step.status === 'done' && step.kind === process.argv[3]) {
      process.send?.({ index });
      await new Promise(() => {});
    }
  },
});
