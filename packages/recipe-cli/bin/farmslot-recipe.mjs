#!/usr/bin/env node
import { runRecipeCli } from '../dist/cli.js';

try {
  await runRecipeCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
