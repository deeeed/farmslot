#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HOOK_SCRIPT = `import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function normalizeInstructionText(value) {
  return String(value)
    .replace(/\\x1b\\[[0-9;]*[A-Za-z]/g, '')
    .replace(/([/-])\\s+/g, '$1')
    .replace(/\\s+/g, ' ')
    .trim();
}

// Keep digest helpers in sync with services/gateway/src/runners/observability-prompt-digest.ts
function instructionNeedle(message) {
  return normalizeInstructionText(message).slice(0, 160);
}

function runnerPromptDigest(message) {
  return crypto.createHash('sha1').update(instructionNeedle(message)).digest('hex').slice(0, 16);
}

function promptTextFromPayload(payload) {
  const raw = payload.prompt ?? payload.user_prompt ?? payload.message;
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

function loadSentinel(sentDir, digest) {
  const full = path.join(sentDir, digest + '.json');
  if (!fs.existsSync(full)) return null;
  const body = JSON.parse(fs.readFileSync(full, 'utf8'));
  return {
    digest: body.digest || digest,
    sentAt: body.sentAt,
  };
}

function matchSentinelForPrompt(sentDir, promptText) {
  const needle = instructionNeedle(promptText);
  const expectedDigest = runnerPromptDigest(promptText);
  const exact = loadSentinel(sentDir, expectedDigest);
  if (exact) return exact;
  let files = [];
  try {
    files = fs.readdirSync(sentDir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  for (const file of files) {
    const body = JSON.parse(fs.readFileSync(path.join(sentDir, file), 'utf8'));
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (needle && prompt && (prompt === needle || needle.startsWith(prompt) || prompt.startsWith(needle))) {
      return {
        digest: body.digest || file.replace(/\\.json$/, ''),
        sentAt: body.sentAt,
      };
    }
  }
  return null;
}

function rotateIfLarge(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= 5 * 1024 * 1024) return;
    fs.renameSync(filePath, filePath + '.1');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

try {
  const raw = readStdin();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const obsDir = process.env.FARMSLOT_OBS_DIR || path.join(process.cwd(), '.observability');
  fs.mkdirSync(obsDir, { recursive: true });
  const logPath = path.join(obsDir, 'hooks.jsonl');
  rotateIfLarge(logPath);
  const observedAt = Date.now();
  const event = payload.hook_event_name || payload.event;
  let matchedDigest;
  let sentAt;
  if (event === 'UserPromptSubmit') {
    const sentDir = path.join(obsDir, 'sent');
    const promptText = promptTextFromPayload(payload);
    const matched = promptText ? matchSentinelForPrompt(sentDir, promptText) : null;
    if (matched) {
      matchedDigest = matched.digest;
      sentAt = matched.sentAt;
    }
  }
  const record = {
    schemaVersion: 1,
    observedAt,
    timestamp: observedAt,
    hook_event_name: event,
    event,
    session_id: payload.session_id,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    permission_mode: payload.permission_mode,
    effort: payload.effort,
    tool_name: payload.tool_name,
    tmuxPane: process.env.TMUX_PANE || undefined,
    slotId: process.env.FARMSLOT_SLOT_ID || undefined,
    runner: process.env.FARMSLOT_RUNNER || 'claude',
    ...(matchedDigest ? { runnerPromptDigest: matchedDigest } : {}),
    ...(sentAt ? { sentAt } : {}),
  };
  fs.appendFileSync(logPath, \`\${JSON.stringify(record)}\n\`);
} catch (error) {
  console.error('[farmslot-observability] ' + (error?.message || String(error)));
}
`;

const STATUSLINE_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';

function pickModel(input) {
  return input?.model?.display_name || input?.model?.id || input?.model || '';
}

function pickContextPct(input) {
  const value = input?.context_window?.used_percentage ?? input?.context?.used_percentage;
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

try {
  const raw = fs.readFileSync(0, 'utf8');
  const input = raw.trim() ? JSON.parse(raw) : {};
  const observedAt = Date.now();
  const obsDir = process.env.FARMSLOT_OBS_DIR || path.join(process.cwd(), '.observability');
  fs.mkdirSync(obsDir, { recursive: true });
  const model = pickModel(input);
  const ctxPct = pickContextPct(input);
  const busy = typeof input?.busy === 'boolean' ? input.busy : undefined;
  const record = {
    schemaVersion: 1,
    observedAt,
    timestamp: observedAt,
    mtime: observedAt,
    ...(busy !== undefined ? { busy } : {}),
    model: model || undefined,
    ctxPct,
    mode: input?.permission_mode,
    session_id: input?.session_id,
    cwd: input?.workspace?.current_dir || input?.cwd,
    tmuxPane: process.env.TMUX_PANE || undefined,
    slotId: process.env.FARMSLOT_SLOT_ID || undefined,
    runner: process.env.FARMSLOT_RUNNER || 'claude',
  };
  const target = path.join(obsDir, 'statusline.json');
  const tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, target);
  const bits = ['fs', model, ctxPct === undefined ? undefined : 'ctx:' + ctxPct + '%'].filter(Boolean);
  process.stdout.write(bits.join(' · '));
} catch (error) {
  console.error('[farmslot-statusline] ' + (error?.message || String(error)));
  process.stdout.write('fs');
}
`;

// Claude Code native hook events Farmslot cares about for observability telemetry.
// Validated against code.claude.com hooks guide / Agent SDK event list (2026):
// SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop,
// SubagentStop, StopFailure, PreCompact, PostCompact.
const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
];

// Codex CLI native hook events — must match oh-my-codex MANAGED_HOOK_EVENTS and
// plugins/oh-my-codex/hooks/codex-native-hook.mjs CODEX_HOOK_EVENT_NAMES.
// Codex does NOT emit Claude-only events such as Notification, StopFailure, or SubagentStop.
const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'Stop',
];

const FARMSLOT_HOOK_MARKER = 'farmslot-observability-hook.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    out[key] = value;
    i += 1;
  }
  return out;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readJsonObject(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

function backupOnce(settingsPath, markerPath) {
  if (!fs.existsSync(settingsPath) || fs.existsSync(markerPath)) return;
  const backupPath = `${settingsPath}.farmslot-backup`;
  if (!fs.existsSync(backupPath)) fs.copyFileSync(settingsPath, backupPath);
}

function removeFarmslotHooks(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return;
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const cleanedEntries = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
        cleanedEntries.push(entry);
        continue;
      }
      const keptHooks = entry.hooks.filter(
        (hook) =>
          !(
            hook &&
            typeof hook === 'object' &&
            typeof hook.command === 'string' &&
            hook.command.includes(FARMSLOT_HOOK_MARKER)
          ),
      );
      if (keptHooks.length > 0) cleanedEntries.push({ ...entry, hooks: keptHooks });
    }
    if (cleanedEntries.length > 0) hooks[eventName] = cleanedEntries;
    else delete hooks[eventName];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
}

function mergeClaudeSettings(settingsPath, markerPath, hookCommand, statusCommand) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  backupOnce(settingsPath, markerPath);
  const settings = readJsonObject(settingsPath);
  removeFarmslotHooks(settings);

  settings.hooks =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? settings.hooks
      : {};
  const hook = { type: 'command', command: hookCommand, timeout: 5 };
  for (const eventName of CLAUDE_HOOK_EVENTS) {
    const entries = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    settings.hooks[eventName] = [...entries, { matcher: '', hooks: [hook] }];
  }

  const existingStatus = settings.statusLine;
  const existingCommand =
    existingStatus && typeof existingStatus === 'object'
      ? String(existingStatus.command ?? '')
      : '';
  const statusLineWasOurs = existingCommand.includes('farmslot-statusline.mjs');
  let statusLineInstalled = false;
  if (!existingStatus || statusLineWasOurs) {
    settings.statusLine = { type: 'command', command: statusCommand };
    statusLineInstalled = true;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { statusLineInstalled };
}

function readCodexHooksDocument(filePath) {
  const parsed = readJsonObject(filePath);
  const root = { ...parsed };
  const hooksSource =
    parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)
      ? parsed.hooks
      : {};
  const hooks = JSON.parse(JSON.stringify(hooksSource));
  return { root, hooks };
}

function removeFarmslotCodexHookEntries(hooks) {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return;
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const cleanedEntries = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
        cleanedEntries.push(entry);
        continue;
      }
      const keptHooks = entry.hooks.filter(
        (hook) =>
          !(
            hook &&
            typeof hook === 'object' &&
            typeof hook.command === 'string' &&
            hook.command.includes(FARMSLOT_HOOK_MARKER)
          ),
      );
      if (keptHooks.length > 0) cleanedEntries.push({ ...entry, hooks: keptHooks });
    }
    if (cleanedEntries.length > 0) hooks[eventName] = cleanedEntries;
    else delete hooks[eventName];
  }
}

function mergeCodexHooks(hooksPath, markerPath, hookCommand) {
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  backupOnce(hooksPath, markerPath);
  const { root, hooks } = readCodexHooksDocument(hooksPath);
  removeFarmslotCodexHookEntries(hooks);
  const hook = { type: 'command', command: hookCommand, timeout: 5 };
  for (const eventName of CODEX_HOOK_EVENTS) {
    const entries = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
    hooks[eventName] = [...entries, { hooks: [hook] }];
  }
  root.hooks = hooks;
  fs.writeFileSync(hooksPath, JSON.stringify(root, null, 2) + '\n');
}

function ensureCodexHooksFeature(configPath, markerPath) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  backupOnce(configPath, markerPath);
  let content = '';
  if (fs.existsSync(configPath)) content = fs.readFileSync(configPath, 'utf8');
  if (/\[features\][\s\S]*?\bhooks\s*=\s*true\b/m.test(content)) return;
  const block = '\n[features]\nhooks = true\n';
  fs.writeFileSync(configPath, (content.trimEnd() ? content.trimEnd() + block : block.trimStart()));
}

function writeObservabilityInstallManifest(obsDir, manifest) {
  fs.writeFileSync(
    path.join(obsDir, 'install.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        installedAt: new Date().toISOString(),
        ...manifest,
      },
      null,
      2,
    ) + '\n',
  );
}

function installObservabilityBinaries({ repo, runtimeDir, slotId, runner }) {
  const repoPath = path.resolve(repo);
  const obsDir = path.resolve(repoPath, runtimeDir, '.observability');
  const binDir = path.join(obsDir, 'bin');
  const hookPath = path.join(binDir, 'farmslot-observability-hook.mjs');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(hookPath, HOOK_SCRIPT);
  execFileSync(process.execPath, ['--check', hookPath], { stdio: 'pipe' });
  const compatObsDir = path.join(repoPath, '.observability');
  if (!fs.existsSync(compatObsDir)) fs.symlinkSync(obsDir, compatObsDir, 'dir');
  const hookCommand = [
    `FARMSLOT_OBS_DIR=${shQuote(obsDir)}`,
    `FARMSLOT_SLOT_ID=${shQuote(slotId)}`,
    `FARMSLOT_RUNNER=${shQuote(runner)}`,
    `node ${shQuote(hookPath)}`,
  ].join(' ');
  return { repoPath, obsDir, hookPath, hookCommand };
}

function installClaude({ repo, runtimeDir = '.agent', slotId }) {
  if (!repo) throw new Error('missing --repo');
  if (!slotId) throw new Error('missing --slot-id');
  const { repoPath, obsDir, hookCommand } = installObservabilityBinaries({
    repo,
    runtimeDir,
    slotId,
    runner: 'claude',
  });
  const settingsPath = path.join(repoPath, '.claude', 'settings.local.json');
  const markerPath = path.join(obsDir, '.farmslot-owned');
  const statuslinePath = path.join(obsDir, 'bin', 'farmslot-statusline.mjs');
  fs.writeFileSync(statuslinePath, STATUSLINE_SCRIPT);
  execFileSync(process.execPath, ['--check', statuslinePath], { stdio: 'pipe' });
  const statusCommand = [
    `FARMSLOT_OBS_DIR=${shQuote(obsDir)}`,
    `FARMSLOT_SLOT_ID=${shQuote(slotId)}`,
    `FARMSLOT_RUNNER=${shQuote('claude')}`,
    `node ${shQuote(statuslinePath)}`,
  ].join(' ');
  const { statusLineInstalled } = mergeClaudeSettings(
    settingsPath,
    markerPath,
    hookCommand,
    statusCommand,
  );
  fs.writeFileSync(markerPath, 'farmslot\n');
  writeObservabilityInstallManifest(obsDir, {
    runner: 'claude',
    repo: repoPath,
    runtimeDir,
    slotId,
    statusLineInstalled,
  });
}

function installCodex({ repo, runtimeDir = '.agent', slotId }) {
  if (!repo) throw new Error('missing --repo');
  if (!slotId) throw new Error('missing --slot-id');
  const { repoPath, obsDir, hookCommand } = installObservabilityBinaries({
    repo,
    runtimeDir,
    slotId,
    runner: 'codex',
  });
  const markerPath = path.join(obsDir, '.farmslot-owned');
  const hooksPath = path.join(repoPath, '.codex', 'hooks.json');
  const configPath = path.join(repoPath, '.codex', 'config.toml');
  mergeCodexHooks(hooksPath, markerPath, hookCommand);
  ensureCodexHooksFeature(configPath, markerPath);
  fs.writeFileSync(markerPath, 'farmslot\n');
  writeObservabilityInstallManifest(obsDir, {
    runner: 'codex',
    repo: repoPath,
    runtimeDir,
    slotId,
    statusLineInstalled: false,
  });
}

function install(args) {
  const runner = args.runner || 'claude';
  if (runner === 'claude') installClaude(args);
  else if (runner === 'codex') installCodex(args);
  else throw new Error(`unsupported runner for observability install: ${runner}`);
}

try {
  install(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`[farmslot-observability] install failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
