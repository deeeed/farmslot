#!/usr/bin/env node
import { runRecipeHarnessCli } from '../dist/cli/index.js';

try {
  await runRecipeHarnessCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
