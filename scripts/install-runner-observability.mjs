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
    runner: 'claude',
    ...(matchedDigest ? { runnerPromptDigest: matchedDigest } : {}),
    ...(sentAt ? { sentAt } : {}),
  };
  fs.appendFileSync(logPath, JSON.stringify(record) + '\\n');
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
    runner: 'claude',
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

const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'StopFailure',
];

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
            hook.command.includes('farmslot-observability-hook.mjs')
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
  for (const eventName of HOOK_EVENTS) {
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

function installClaude({ repo, runtimeDir = '.agent', slotId }) {
  if (!repo) throw new Error('missing --repo');
  if (!slotId) throw new Error('missing --slot-id');
  const repoPath = path.resolve(repo);
  const obsDir = path.resolve(repoPath, runtimeDir, '.observability');
  const binDir = path.join(obsDir, 'bin');
  const settingsPath = path.join(repoPath, '.claude', 'settings.local.json');
  const markerPath = path.join(obsDir, '.farmslot-owned');
  const hookPath = path.join(binDir, 'farmslot-observability-hook.mjs');
  const statuslinePath = path.join(binDir, 'farmslot-statusline.mjs');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(hookPath, HOOK_SCRIPT);
  fs.writeFileSync(statuslinePath, STATUSLINE_SCRIPT);
  execFileSync(process.execPath, ['--check', hookPath], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', statuslinePath], { stdio: 'pipe' });

  const compatObsDir = path.join(repoPath, '.observability');
  if (!fs.existsSync(compatObsDir)) fs.symlinkSync(obsDir, compatObsDir, 'dir');

  const hookCommand = `FARMSLOT_OBS_DIR=${shQuote(obsDir)} FARMSLOT_SLOT_ID=${shQuote(slotId)} node ${shQuote(hookPath)}`;
  const statusCommand = `FARMSLOT_OBS_DIR=${shQuote(obsDir)} FARMSLOT_SLOT_ID=${shQuote(slotId)} node ${shQuote(statuslinePath)}`;
  const { statusLineInstalled } = mergeClaudeSettings(
    settingsPath,
    markerPath,
    hookCommand,
    statusCommand,
  );
  fs.writeFileSync(markerPath, 'farmslot\n');
  fs.writeFileSync(
    path.join(obsDir, 'install.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        installedAt: new Date().toISOString(),
        runner: 'claude',
        repo: repoPath,
        runtimeDir,
        slotId,
        statusLineInstalled,
      },
      null,
      2,
    ) + '\n',
  );
}

function install(args) {
  const runner = args.runner || 'claude';
  if (runner !== 'claude') {
    throw new Error(`unsupported runner for observability install: ${runner}`);
  }
  installClaude(args);
}

try {
  install(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`[farmslot-observability] install failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
