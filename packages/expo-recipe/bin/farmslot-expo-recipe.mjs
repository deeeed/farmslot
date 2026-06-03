#!/usr/bin/env node
import { runExpoRecipeCli } from '../dist/cli.js';

try {
  await runExpoRecipeCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
