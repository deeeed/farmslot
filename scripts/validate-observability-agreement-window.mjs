#!/usr/bin/env node
/**
 * Optional fleet diagnostic — analyze hook-vs-pane agreement NDJSON.
 *
 * Not part of ADR-032 Phase 1 closeout. Run manually when hooks are enabled on
 * live slots and you want a snapshot of hook-vs-pane agreement.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    dir: path.join(ROOT, '.runs', 'observability-agreement'),
    minEvents: 1,
    minRate: 0,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dir') args.dir = path.resolve(argv[++i]);
    else if (token === '--min-events') args.minEvents = Number(argv[++i]);
    else if (token === '--min-rate') args.minRate = Number(argv[++i]);
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--help' || token === '-h') {
      console.log(
        'usage: validate-observability-agreement-window.mjs [--dir <path>] [--min-events 1] [--min-rate 0] [--out report.json]',
      );
      process.exit(0);
    }
  }
  return args;
}

function loadAgreementRows(dir) {
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.ndjson')) continue;
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // skip malformed lines — counted separately
      }
    }
  }
  return rows;
}

function summarize(rows, minEvents, minRate) {
  const comparable = rows.filter((row) => row.agreed === true || row.agreed === false);
  const agreed = comparable.filter((row) => row.agreed === true);
  const rate = comparable.length > 0 ? agreed.length / comparable.length : 0;
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    totalRows: rows.length,
    comparableRows: comparable.length,
    agreedRows: agreed.length,
    agreementRate: rate,
    gate: {
      minEvents,
      minRate,
      eventsPass: comparable.length >= minEvents,
      ratePass: comparable.length === 0 ? false : rate >= minRate,
    },
    disagreements: comparable
      .filter((row) => row.agreed === false)
      .slice(0, 20)
      .map((row) => ({
        timestamp: row.timestamp,
        slotId: row.slotId,
        runner: row.runner,
        reason: row.disagreementReason,
      })),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = loadAgreementRows(args.dir);
  const report = summarize(rows, args.minEvents, args.minRate);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) fs.writeFileSync(args.out, text);
  else process.stdout.write(text);
  if (!report.gate.eventsPass || !report.gate.ratePass) process.exit(1);
}

main();