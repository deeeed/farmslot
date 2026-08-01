#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveProviderAccountForSlot } from './lib/provider-accounts.mjs';

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
    notification_type: payload.notification_type,
    tmuxPane: process.env.TMUX_PANE || undefined,
    slotId: process.env.FARMSLOT_SLOT_ID || undefined,
    runner: process.env.FARMSLOT_RUNNER || 'claude',
    ...(matchedDigest ? { runnerPromptDigest: matchedDigest } : {}),
    ...(sentAt ? { sentAt } : {}),
  };
  fs.appendFileSync(logPath, \`\${JSON.stringify(record)}\n\`);
  if (typeof record.session_id === 'string' && record.session_id) {
    const sessionsDir = path.join(obsDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const statePath = path.join(sessionsDir, encodeURIComponent(record.session_id) + '.json');
    const pendingPath = statePath + '.' + process.pid + '.tmp';
    fs.writeFileSync(pendingPath, \`\${JSON.stringify(record)}\n\`);
    fs.renameSync(pendingPath, statePath);
  }
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

const CODEX_HOOK_EVENT_LABELS = {
  SessionStart: 'session_start',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  UserPromptSubmit: 'user_prompt_submit',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  Stop: 'stop',
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function versionForCodexTomlIdentity(value) {
  const serialized = JSON.stringify(canonicalJson(value));
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

function escapeTomlBasicString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizedCommandHookIdentity(eventName, entry, hook) {
  return {
    event_name: CODEX_HOOK_EVENT_LABELS[eventName],
    ...(entry.matcher ? { matcher: entry.matcher } : {}),
    hooks: [
      {
        type: 'command',
        command: hook.command,
        timeout: Math.max(1, hook.timeout ?? 600),
        async: false,
        ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
      },
    ],
  };
}

function buildCodexHookTrustToml(hooksPath, hooks) {
  const blocks = [];
  for (const eventName of CODEX_HOOK_EVENTS) {
    const entries = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
    entries.forEach((entry, groupIndex) => {
      if (!entry || !Array.isArray(entry.hooks)) return;
      entry.hooks.forEach((hook, handlerIndex) => {
        if (!hook || hook.type !== 'command' || typeof hook.command !== 'string') return;
        const key = `${hooksPath}:${CODEX_HOOK_EVENT_LABELS[eventName]}:${groupIndex}:${handlerIndex}`;
        const trustedHash = versionForCodexTomlIdentity(
          normalizedCommandHookIdentity(eventName, entry, hook),
        );
        blocks.push(
          `[hooks.state."${escapeTomlBasicString(key)}"]`,
          `trusted_hash = "${escapeTomlBasicString(trustedHash)}"`,
          '',
        );
      });
    });
  }
  return blocks.join('\n').trimEnd();
}

function stripTomlSections(content, shouldStrip) {
  const lines = content.split('\n');
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    // Codex config sections touched here are ordinary `[table]` headers. This
    // intentionally does not parse TOML array-of-tables (`[[table]]`); do not
    // reuse it for configs where generated sections may be arrays.
    const section = line.trim().match(/^\[([^\]]+)\]\s*$/)?.[1] ?? null;
    if (section) skipping = shouldStrip(section);
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').trimEnd();
}

function stripCodexHomeInstallerSections(content, repoPath) {
  const canonicalRepoPath = canonicalCodexPath(repoPath);
  const projectSection = `projects."${escapeTomlBasicString(canonicalRepoPath)}"`;
  return stripTomlSections(content, (section) => {
    if (section === projectSection) return true;
    if (section.startsWith('hooks.state.')) return true;
    return false;
  });
}

function upsertCodexHooksFeature(content) {
  const lines = content.split('\n');
  const existingFeatureIdx = lines.findIndex((line) => line.trim() === '[features]');
  if (existingFeatureIdx < 0) {
    const block = '[features]\nhooks = true\n';
    return content.trimEnd() ? `${content.trimEnd()}\n\n${block.trimEnd()}` : block.trimEnd();
  }

  let sectionEnd = lines.length;
  for (let i = existingFeatureIdx + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let sawHooks = false;
  const sectionLines = lines.slice(existingFeatureIdx + 1, sectionEnd).map((line) => {
    if (/^\s*hooks\s*=/.test(line)) {
      sawHooks = true;
      return 'hooks = true';
    }
    return line;
  });
  if (!sawHooks) sectionLines.push('hooks = true');
  return [...lines.slice(0, existingFeatureIdx + 1), ...sectionLines, ...lines.slice(sectionEnd)]
    .join('\n')
    .trimEnd();
}

function canonicalCodexPath(filePath) {
  try {
    return fs.realpathSync(path.resolve(filePath));
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Bind codex-home/auth.json to the desired credential source via symlink only.
 * Never write through the link; never unlink a regular file (may be a real operator credential).
 * existsSync follows symlinks, so use lstat/readlink for correct presence/target checks.
 */
function linkCodexAuth(destAuth, authSource, { requireSource = false, label = null } = {}) {
  const source = path.resolve(authSource);
  if (!fs.existsSync(source)) {
    // Forced/bound seats must fail closed so we never stamp label B while still auth'd as A.
    if (requireSource) {
      throw new Error(
        `Provider account auth missing at ${source}${label ? ` for label '${label}'` : ''}; refusing silent bind no-op`,
      );
    }
    // True ambient bootstrap: leave dest alone when source absent; do not create a dangling link.
    return;
  }

  let destStat = null;
  try {
    destStat = fs.lstatSync(destAuth);
  } catch {
    destStat = null;
  }

  if (destStat?.isSymbolicLink()) {
    let currentTarget = null;
    try {
      currentTarget = fs.readlinkSync(destAuth);
    } catch {
      currentTarget = null;
    }
    const resolvedCurrent = currentTarget
      ? path.resolve(path.dirname(destAuth), currentTarget)
      : null;
    if (resolvedCurrent === source) return;
    fs.unlinkSync(destAuth);
  } else if (destStat) {
    // Regular file or directory — fail loudly rather than destroy operator credentials.
    throw new Error(
      `codex-home auth.json at ${destAuth} is a real file, not a symlink; refusing to replace it. Remove it manually if you intend Farmslot to manage the auth link.`,
    );
  }

  fs.symlinkSync(source, destAuth);
}

function resolveCodexAuthOnThisHost({ slotId, authSource, accountLabel }) {
  // Explicit path wins (tests / rare overrides). Prefer --account-label so paths
  // expand on THIS machine (multi-node safe).
  if (authSource) {
    return {
      label: accountLabel || null,
      authPath: path.resolve(authSource),
      source: 'auth-source-arg',
    };
  }
  const resolved = resolveProviderAccountForSlot({
    slotId: slotId || 'unknown-slot',
    provider: 'codex',
    forcedLabel: accountLabel || null,
  });
  return {
    label: resolved.label,
    authPath: resolved.authPath,
    source: resolved.source,
  };
}

async function bootstrapCodexHome({
  repoPath,
  runtimeDir,
  hooksPath,
  authSource,
  accountLabel,
  slotId,
}) {
  const codexHomeDir = path.join(repoPath, runtimeDir, 'codex-home');
  fs.mkdirSync(codexHomeDir, { recursive: true });
  const hooksDoc = readJsonObject(hooksPath);
  const hooks =
    hooksDoc.hooks && typeof hooksDoc.hooks === 'object' && !Array.isArray(hooksDoc.hooks)
      ? hooksDoc.hooks
      : {};
  const absoluteHooksPath = path.resolve(hooksPath);
  const codexHomeHooksPath = path.join(codexHomeDir, 'hooks.json');
  fs.copyFileSync(absoluteHooksPath, codexHomeHooksPath);
  // Codex with CODEX_HOME reads hooks from codex-home; trusted_hash keys must use that path.
  const trustHooksPath = canonicalCodexPath(codexHomeHooksPath);
  const trustToml = buildCodexHookTrustToml(trustHooksPath, hooks);
  const configPath = path.join(codexHomeDir, 'config.toml');
  // Never read or write through a symlink. A stale codex-home/config.toml symlinked to
  // the operator's global ~/.codex/config.toml would make us read the global config,
  // append our hook-trust block, and write it BACK to global — corrupting it (duplicate
  // [features]). Drop any symlink so we always operate on a real, isolated file.
  let content = '';
  let existingStat = null;
  try {
    existingStat = fs.lstatSync(configPath);
  } catch {
    existingStat = null;
  }
  if (existingStat?.isSymbolicLink()) {
    fs.rmSync(configPath);
  } else if (existingStat) {
    content = fs.readFileSync(configPath, 'utf8');
  }
  content = upsertCodexHooksFeature(stripCodexHomeInstallerSections(content, repoPath));
  const canonicalRepoPath = canonicalCodexPath(repoPath);
  const projectBlock = `[projects."${escapeTomlBasicString(canonicalRepoPath)}"]\ntrust_level = "trusted"\n`;
  const merged = [content, trustToml, projectBlock].filter(Boolean).join('\n').trimEnd() + '\n';
  fs.writeFileSync(configPath, merged);
  const resolved = await resolveCodexAuthOnThisHost({ slotId, authSource, accountLabel });
  const destAuth = path.join(codexHomeDir, 'auth.json');
  const requireSource =
    Boolean(authSource) ||
    Boolean(
      accountLabel && String(accountLabel).trim() && String(accountLabel).trim() !== 'ambient',
    ) ||
    Boolean(resolved.label && resolved.label !== 'ambient' && !resolved.ambient);
  linkCodexAuth(destAuth, resolved.authPath, {
    requireSource,
    label: resolved.label || accountLabel || null,
  });
  return { codexHomeDir, resolvedAuth: resolved };
}

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
  const next = upsertCodexHooksFeature(content);
  if (next === content.trimEnd()) return;
  fs.writeFileSync(configPath, `${next}\n`);
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

function ensureCompatObservabilityLink(repoPath, obsDir) {
  const compatObsDir = path.join(repoPath, '.observability');
  let stat;
  try {
    stat = fs.lstatSync(compatObsDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fs.symlinkSync(obsDir, compatObsDir, 'dir');
    return;
  }

  if (!stat.isSymbolicLink()) return;
  const currentTarget = path.resolve(path.dirname(compatObsDir), fs.readlinkSync(compatObsDir));
  if (currentTarget === obsDir) return;
  fs.unlinkSync(compatObsDir);
  fs.symlinkSync(obsDir, compatObsDir, 'dir');
}

function installObservabilityBinaries({ repo, runtimeDir, slotId, runner }) {
  const repoPath = path.resolve(repo);
  const obsDir = path.resolve(repoPath, runtimeDir, '.observability');
  const binDir = path.join(obsDir, 'bin');
  const hookPath = path.join(binDir, 'farmslot-observability-hook.mjs');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(hookPath, HOOK_SCRIPT);
  execFileSync(process.execPath, ['--check', hookPath], { stdio: 'pipe' });
  ensureCompatObservabilityLink(repoPath, obsDir);
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

async function installCodex({ repo, runtimeDir = '.agent', slotId, authSource, accountLabel }) {
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
  const projectConfigPath = path.join(repoPath, '.codex', 'config.toml');
  mergeCodexHooks(hooksPath, markerPath, hookCommand);
  ensureCodexHooksFeature(projectConfigPath, markerPath);
  const { codexHomeDir, resolvedAuth } = await bootstrapCodexHome({
    repoPath,
    runtimeDir,
    hooksPath,
    authSource: authSource || undefined,
    accountLabel: accountLabel || undefined,
    slotId,
  });
  fs.writeFileSync(markerPath, 'farmslot\n');
  writeObservabilityInstallManifest(obsDir, {
    runner: 'codex',
    repo: repoPath,
    runtimeDir,
    slotId,
    codexHomeDir,
    authSource: resolvedAuth.authPath || null,
    accountLabel: resolvedAuth.label || null,
    accountSource: resolvedAuth.source || null,
    statusLineInstalled: false,
  });
  if (resolvedAuth.label) {
    console.log(
      `[farmslot-observability] codex account label=${resolvedAuth.label} source=${resolvedAuth.source}`,
    );
  }
}

async function install(args) {
  const runner = args.runner || 'claude';
  if (runner === 'claude') installClaude(args);
  else if (runner === 'codex') await installCodex(args);
  else throw new Error(`unsupported runner for observability install: ${runner}`);
}

try {
  await install(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`[farmslot-observability] install failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
