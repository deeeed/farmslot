#!/usr/bin/env node
/**
 * Execution-host CLI for provider subscription accounts.
 * Run on the machine that owns the credentials (gateway host for local slots,
 * remote node for remote slots). Emits JSON on stdout for gateway consumption.
 *
 * Usage:
 *   node scripts/provider-account-cli.mjs resolve --slot-id S [--label L] [--provider codex]
 *   node scripts/provider-account-cli.mjs list-eligible --provider codex [--exclude a,b]
 *   node scripts/provider-account-cli.mjs mark-exhausted --label L [--provider codex]
 *   node scripts/provider-account-cli.mjs record-success --label L
 *   node scripts/provider-account-cli.mjs get-active --provider codex
 *   node scripts/provider-account-cli.mjs set-active --provider codex --label L
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AMBIENT_ACCOUNT_LABEL,
  earliestExhaustionExpiry,
  farmslotHomeFromEnv,
  listEligibleLabels,
  loadActiveProviderProfiles,
  loadExhaustionLedger,
  loadProviderAccountsConfig,
  markAccountExhausted,
  providerFailoverCandidates,
  recordAccountSuccess,
  resolveProviderAccountForSlot,
  saveActiveProviderProfile,
} from './lib/provider-accounts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args._[0] || args.action;
  const home = args.home ? path.resolve(args.home) : farmslotHomeFromEnv();
  const provider = args.provider || 'codex';

  if (!action || action === 'help' || args.help) {
    emit({
      ok: true,
      help: [
        'resolve --slot-id S [--label L] [--provider codex]',
        'list-eligible --provider codex [--exclude a,b]',
        'mark-exhausted --label L [--provider codex]',
        'record-success --label L',
        'get-active --provider codex',
        'set-active --provider codex --label L',
      ],
      home,
      cli: path.join(__dirname, 'provider-account-cli.mjs'),
    });
    return;
  }

  if (action === 'resolve') {
    if (!args.slotId) throw new Error('missing --slot-id');
    const resolved = resolveProviderAccountForSlot({
      slotId: args.slotId,
      provider,
      forcedLabel: args.label || null,
      home,
    });
    emit({ ok: true, action, home, ...resolved });
    return;
  }

  if (action === 'list-eligible') {
    const exclude = args.exclude
      ? String(args.exclude)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const eligible = listEligibleLabels({ provider, home, exclude });
    const all = providerFailoverCandidates({ provider, home, exclude: [] });
    const ledger = loadExhaustionLedger(home);
    emit({
      ok: true,
      action,
      home,
      provider,
      eligible,
      all,
      earliestExpiry: earliestExhaustionExpiry(all, { home, ledger }),
      ambientLabel: AMBIENT_ACCOUNT_LABEL,
    });
    return;
  }

  if (action === 'mark-exhausted') {
    if (!args.label) throw new Error('missing --label');
    const entry = markAccountExhausted({
      label: args.label,
      provider,
      home,
    });
    emit({ ok: true, action, home, entry });
    return;
  }

  if (action === 'record-success') {
    if (!args.label) throw new Error('missing --label');
    recordAccountSuccess({ label: args.label, home });
    emit({ ok: true, action, home, label: args.label });
    return;
  }

  if (action === 'get-active') {
    const profiles = loadActiveProviderProfiles(home);
    emit({
      ok: true,
      action,
      home,
      provider,
      label: profiles[provider] || null,
      profiles,
    });
    return;
  }

  if (action === 'set-active') {
    if (!args.label) throw new Error('missing --label');
    // Validate label exists when config is present
    const config = loadProviderAccountsConfig(home);
    if (config && args.label !== AMBIENT_ACCOUNT_LABEL && !config.accounts[args.label]) {
      throw new Error(
        `Unknown account label '${args.label}' (known: ${Object.keys(config.accounts).join(', ') || 'none'})`,
      );
    }
    if (config?.accounts[args.label] && config.accounts[args.label].provider !== provider) {
      throw new Error(
        `Account '${args.label}' is provider '${config.accounts[args.label].provider}', expected '${provider}'`,
      );
    }
    const profiles = saveActiveProviderProfile(provider, args.label, home);
    emit({ ok: true, action, home, provider, label: args.label, profiles });
    return;
  }

  throw new Error(`unknown action: ${action}`);
}

try {
  main();
} catch (err) {
  emit({ ok: false, error: err?.message || String(err) });
  process.exitCode = 1;
}
