#!/usr/bin/env node
import { runAdapterRnCli } from '../dist/cli.js';

try {
  await runAdapterRnCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
