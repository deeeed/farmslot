#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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

function writeSnapshot(directory, key, record) {
  fs.mkdirSync(directory, { recursive: true });
  const statePath = path.join(directory, encodeURIComponent(key) + '.json');
  const pendingPath = statePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(pendingPath, \`\${JSON.stringify(record)}\n\`);
  fs.renameSync(pendingPath, statePath);
}

function readSnapshot(directory, key) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(directory, encodeURIComponent(key) + '.json'), 'utf8'),
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
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
  const previousSession =
    typeof payload.session_id === 'string' && payload.session_id
      ? readSnapshot(path.join(obsDir, 'sessions'), payload.session_id)
      : null;
  const previousPane =
    typeof process.env.TMUX_PANE === 'string' && process.env.TMUX_PANE
      ? readSnapshot(path.join(obsDir, 'panes'), process.env.TMUX_PANE)
      : null;
  const startsTurn = event === 'UserPromptSubmit';
  const preservesTurnAcrossSessionStart = event === 'SessionStart' && payload.source === 'compact';
  const resetsTurn = event === 'SessionStart' && !preservesTurnAcrossSessionStart;
  const stopsTurn =
    event === 'Stop' ||
    event === 'StopFailure' ||
    (event === 'Notification' && payload.notification_type === 'idle_prompt');
  const turnStartedAt = startsTurn
    ? observedAt
    : resetsTurn
      ? undefined
      : previousSession?.turnStartedAt;
  const turnActive = startsTurn
    ? true
    : resetsTurn
      ? false
      : stopsTurn
        ? false
        : typeof previousSession?.turnActive === 'boolean'
          ? previousSession.turnActive
          : undefined;
  const rootSessionId =
    event === 'SessionStart'
      ? payload.session_id
      : previousPane?.rootSessionId || previousPane?.session_id || payload.session_id;
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
    source: payload.source,
    tmuxPane: process.env.TMUX_PANE || undefined,
    slotId: process.env.FARMSLOT_SLOT_ID || undefined,
    runner: process.env.FARMSLOT_RUNNER || 'claude',
    ...(typeof turnStartedAt === 'number' ? { turnStartedAt } : {}),
    ...(typeof turnActive === 'boolean' ? { turnActive } : {}),
    ...(typeof rootSessionId === 'string' && rootSessionId ? { rootSessionId } : {}),
    ...(matchedDigest ? { runnerPromptDigest: matchedDigest } : {}),
    ...(sentAt ? { sentAt } : {}),
  };
  fs.appendFileSync(logPath, \`\${JSON.stringify(record)}\n\`);
  if (typeof record.session_id === 'string' && record.session_id) {
    writeSnapshot(path.join(obsDir, 'sessions'), record.session_id, record);
  }
  if (typeof record.tmuxPane === 'string' && record.tmuxPane) {
    writeSnapshot(path.join(obsDir, 'panes'), record.tmuxPane, record);
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

function isTomlSectionHeader(line) {
  return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line);
}

function scanTomlLine(line, state) {
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (state.quote === '"""' || state.quote === "'''") {
      if (state.quote === '"""' && escaped) {
        escaped = false;
        continue;
      }
      if (state.quote === '"""' && char === '\\') {
        escaped = true;
        continue;
      }
      if (line.startsWith(state.quote, index)) {
        const quoteChar = state.quote[0];
        let closingRunLength = 3;
        while (line[index + closingRunLength] === quoteChar) closingRunLength += 1;
        index += closingRunLength - 1;
        state.quote = null;
      }
      continue;
    }
    if (state.quote) {
      if (state.quote === '"' && escaped) {
        escaped = false;
      } else if (state.quote === '"' && char === '\\') {
        escaped = true;
      } else if (char === state.quote) {
        state.quote = null;
      }
      continue;
    }
    if (char === '#') break;
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      state.quote = line.slice(index, index + 3);
      index += 2;
    } else if (char === '"' || char === "'") {
      state.quote = char;
    } else if (char === '[') {
      state.arrayDepth += 1;
    } else if (char === ']') {
      state.arrayDepth = Math.max(0, state.arrayDepth - 1);
    }
  }
  // Ordinary TOML strings cannot span physical lines. Multiline strings are
  // retained in state until their matching triple quote is encountered.
  if (state.quote === '"' || state.quote === "'") state.quote = null;
}

function tomlSectionHeaderIndexes(lines) {
  const headers = new Set();
  const state = { arrayDepth: 0, quote: null };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (state.arrayDepth === 0 && state.quote === null && isTomlSectionHeader(line)) {
      headers.add(index);
      continue;
    }
    scanTomlLine(line, state);
  }
  return headers;
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
  const headers = tomlSectionHeaderIndexes(lines);
  const kept = [];
  let skipping = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // Codex config sections touched here are ordinary `[table]` headers. This
    // intentionally does not parse TOML array-of-tables (`[[table]]`); do not
    // reuse it for configs where generated sections may be arrays.
    const section = headers.has(index) ? (line.trim().match(/^\[([^\]]+)\]/)?.[1] ?? null) : null;
    if (section) skipping = shouldStrip(section);
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').trimEnd();
}

function tomlBareStringValue(line, key) {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
  if (!match) return null;
  const raw = match[1].trim();
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0];
    let value = '';
    for (let index = 1; index < raw.length; index += 1) {
      const char = raw[index];
      if (char === '\\' && index + 1 < raw.length) {
        value += raw[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) return value;
      value += char;
    }
    return null;
  }
  return raw.replace(/\s+#.*$/, '').trim() || null;
}

function tomlSectionName(line) {
  return line.trim().match(/^\[([^\]]+)\]/)?.[1] ?? null;
}

function tomlDottedParts(section) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < section.length; index += 1) {
    const char = section[index];
    if (quote) {
      if (char === '\\' && index + 1 < section.length) {
        current += section[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '.') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

function sectionBelongsToProvider(section, providerId) {
  if (!section) return false;
  const parts = tomlDottedParts(section);
  return parts[0] === 'model_providers' && parts[1] === providerId;
}

function managedInstallerProviderId(content) {
  for (const line of content.split('\n')) {
    const match = line.trim().match(/^#\s*farmslot-managed-model-provider\s*=\s*"([^"]+)"\s*$/);
    if (match) return match[1];
  }
  return null;
}

function rootTomlModelProvider(content) {
  const lines = content.split('\n');
  const headers = tomlSectionHeaderIndexes(lines);
  let providerLine = null;
  let providerId = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (headers.has(index)) break;
    if (!/^\s*model_provider\s*=/.test(lines[index])) continue;
    providerLine = lines[index];
    providerId = tomlBareStringValue(lines[index], 'model_provider');
  }
  return { providerLine, providerId };
}

function stripCodexHomeInstallerSections(
  content,
  repoPath,
  providerIds = [],
  { replaceRootProvider = false } = {},
) {
  const canonicalRepoPath = canonicalCodexPath(repoPath);
  const projectSection = `projects."${escapeTomlBasicString(canonicalRepoPath)}"`;
  const managedIds = [...new Set(providerIds.filter(Boolean))];
  const withoutSections = stripTomlSections(content, (section) => {
    if (section === projectSection) return true;
    if (managedIds.some((id) => sectionBelongsToProvider(section, id))) return true;
    if (section.startsWith('hooks.state.')) return true;
    return false;
  });
  const lines = withoutSections.split('\n');
  const headers = tomlSectionHeaderIndexes(lines);
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (headers.has(index)) {
      kept.push(...lines.slice(index));
      break;
    }
    if (/^\s*#\s*farmslot-managed-model-provider\s*=/.test(lines[index])) continue;
    if (/^\s*model_provider\s*=/.test(lines[index])) {
      const id = tomlBareStringValue(lines[index], 'model_provider');
      if (replaceRootProvider || !id || managedIds.includes(id)) continue;
    }
    kept.push(lines[index]);
  }
  return kept.join('\n').trimEnd();
}

function operatorCodexRoutingToml() {
  const globalPath = path.join(os.homedir(), '.codex', 'config.toml');
  let content = '';
  try {
    content = fs.readFileSync(globalPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
  const { providerLine, providerId } = rootTomlModelProvider(content);
  if (!providerLine || !providerId) return '';
  const lines = content.split('\n');
  const headers = tomlSectionHeaderIndexes(lines);
  const table = [providerLine, ''];
  let copying = false;
  let sawProviderTable = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (headers.has(index)) {
      const name = tomlSectionName(lines[index]);
      const parts = tomlDottedParts(name ?? '');
      copying = sectionBelongsToProvider(name, providerId);
      if (copying && parts.length === 2) sawProviderTable = true;
    }
    if (copying) table.push(lines[index]);
  }
  if (!sawProviderTable) return '';
  return table.join('\n').trimEnd();
}

function injectOperatorCodexRouting(content, routing) {
  const { providerLine, providerId } = rootTomlModelProvider(routing);
  if (!providerLine) return content;
  const routingLines = routing.split('\n');
  const firstTable = routingLines.findIndex((line) => tomlSectionName(line));
  const tables = firstTable >= 0 ? routingLines.slice(firstTable).join('\n').trimEnd() : '';
  const contentLines = content.split('\n');
  const headers = tomlSectionHeaderIndexes(contentLines);
  let firstHeader = contentLines.length;
  for (let index = 0; index < contentLines.length; index += 1) {
    if (!headers.has(index)) continue;
    firstHeader = index;
    break;
  }
  const root = contentLines.slice(0, firstHeader);
  const rest = contentLines.slice(firstHeader);
  const merged = [providerLine];
  if (providerId) merged.push(`# farmslot-managed-model-provider = "${providerId}"`);
  if (root.some((line) => line.trim() !== '')) merged.push(...root);
  if (tables) merged.push('', tables);
  if (rest.length) merged.push(...rest);
  return merged.join('\n').trimEnd();
}

function coalesceCodexFeaturesSections(content) {
  const lines = content.split('\n');
  const headers = tomlSectionHeaderIndexes(lines);
  const bodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!headers.has(i) || lines[i].trim() !== '[features]') continue;
    const body = [];
    for (i += 1; i < lines.length && !headers.has(i); i += 1) {
      body.push(lines[i]);
    }
    i -= 1;
    bodies.push(body);
  }
  if (bodies.length <= 1) return content;

  const merged = [];
  const assignmentIndexes = new Map();
  for (const line of bodies.flat()) {
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (assignment) {
      const key = assignment[1];
      const existing = assignmentIndexes.get(key);
      if (existing === undefined) {
        assignmentIndexes.set(key, merged.length);
        merged.push(line);
      } else {
        merged[existing] = line;
      }
      continue;
    }
    merged.push(line);
  }

  const output = [];
  let inserted = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!headers.has(i) || lines[i].trim() !== '[features]') {
      output.push(lines[i]);
      continue;
    }
    if (!inserted) {
      output.push('[features]', ...merged);
      inserted = true;
    }
    for (i += 1; i < lines.length && !headers.has(i); i += 1) {
      // Skip the body of every original features section; it was merged above.
    }
    i -= 1;
  }
  return output.join('\n').trimEnd();
}

function upsertCodexHooksFeature(content) {
  content = coalesceCodexFeaturesSections(content);
  const lines = content.split('\n');
  const headers = tomlSectionHeaderIndexes(lines);
  const existingFeatureIdx = lines.findIndex(
    (line, index) => headers.has(index) && line.trim() === '[features]',
  );
  if (existingFeatureIdx < 0) {
    const block = '[features]\nhooks = true\n';
    return content.trimEnd() ? `${content.trimEnd()}\n\n${block.trimEnd()}` : block.trimEnd();
  }

  let sectionEnd = lines.length;
  for (let i = existingFeatureIdx + 1; i < lines.length; i += 1) {
    if (headers.has(i)) {
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

function restoreLegacyCodexHooksFeature(currentContent, backupContent) {
  const generatedContent = `${upsertCodexHooksFeature(backupContent)}\n`;
  if (generatedContent === backupContent) return currentContent;

  const sectionBounds = (lines) => {
    const headers = tomlSectionHeaderIndexes(lines);
    const start = lines.findIndex(
      (line, index) => headers.has(index) && line.trim() === '[features]',
    );
    if (start < 0) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (headers.has(i)) {
        end = i;
        break;
      }
    }
    return { start, end };
  };
  const keyLineIndex = (lines, bounds) => {
    if (!bounds) return -1;
    for (let i = bounds.start + 1; i < bounds.end; i += 1) {
      const equals = lines[i].indexOf('=');
      if (equals >= 0 && lines[i].slice(0, equals).trim() === 'hooks') return i;
    }
    return -1;
  };

  const currentLines = currentContent.split('\n');
  const backupLines = backupContent.split('\n');
  const currentBounds = sectionBounds(currentLines);
  const backupBounds = sectionBounds(backupLines);
  const currentHookIndex = keyLineIndex(currentLines, currentBounds);
  const backupHookIndex = keyLineIndex(backupLines, backupBounds);
  if (currentHookIndex < 0 || currentLines[currentHookIndex].trim() !== 'hooks = true') return null;

  if (backupHookIndex >= 0) {
    currentLines[currentHookIndex] = backupLines[backupHookIndex];
  } else {
    currentLines.splice(currentHookIndex, 1);
    if (!backupBounds) {
      const updatedBounds = sectionBounds(currentLines);
      const hasFeatureContent = currentLines
        .slice(updatedBounds.start + 1, updatedBounds.end)
        .some((line) => line.trim());
      if (!hasFeatureContent)
        currentLines.splice(updatedBounds.start, updatedBounds.end - updatedBounds.start);
    }
  }
  return currentLines.join('\n');
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
  const routing = operatorCodexRoutingToml();
  const nextProviderId = routing ? rootTomlModelProvider(routing).providerId : null;
  const isolatedRootId = rootTomlModelProvider(content).providerId;
  const previousProviderId =
    managedInstallerProviderId(content) ??
    (isolatedRootId && isolatedRootId === nextProviderId ? isolatedRootId : null);
  content = upsertCodexHooksFeature(
    stripCodexHomeInstallerSections(content, repoPath, [previousProviderId, nextProviderId], {
      replaceRootProvider: Boolean(nextProviderId),
    }),
  );
  if (routing) {
    content = injectOperatorCodexRouting(content, routing);
  }
  const canonicalRepoPath = canonicalCodexPath(repoPath);
  const projectBlock = `[projects."${escapeTomlBasicString(canonicalRepoPath)}"]\ntrust_level = "trusted"\n`;
  const merged = [content, trustToml, projectBlock].filter(Boolean).join('\n').trimEnd() + '\n';
  fs.writeFileSync(configPath, merged);
  fs.chmodSync(configPath, 0o600);
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
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  let removed = false;
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
      if (keptHooks.length !== entry.hooks.length) removed = true;
      if (keptHooks.length > 0) cleanedEntries.push({ ...entry, hooks: keptHooks });
    }
    if (cleanedEntries.length > 0) hooks[eventName] = cleanedEntries;
    else delete hooks[eventName];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}

function cleanupLegacyClaudeSettings(repoPath, obsDir) {
  const settingsDir = path.join(repoPath, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.local.json');
  const backupPath = `${settingsPath}.farmslot-backup`;
  let settingsDirStat = null;
  try {
    settingsDirStat = fs.lstatSync(settingsDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // A linked project settings directory is operator-owned. Never traverse it:
  // cleanup must not mutate files outside the slot checkout.
  if (settingsDirStat && !settingsDirStat.isDirectory()) return;

  if (fs.existsSync(backupPath)) {
    fs.mkdirSync(obsDir, { recursive: true });
    fs.renameSync(backupPath, path.join(obsDir, 'legacy-claude-settings.farmslot-backup'));
  }
  if (!fs.existsSync(settingsPath)) {
    if (fs.existsSync(settingsDir) && fs.readdirSync(settingsDir).length === 0) {
      fs.rmdirSync(settingsDir);
    }
    return;
  }

  const settingsStat = fs.lstatSync(settingsPath);
  const settings = readJsonObject(settingsPath);
  const removedHooks = removeFarmslotHooks(settings);
  const statusCommand =
    settings.statusLine && typeof settings.statusLine === 'object'
      ? String(settings.statusLine.command ?? '')
      : '';
  const removedStatusLine = statusCommand.includes('farmslot-statusline.mjs');
  if (removedStatusLine) delete settings.statusLine;
  if (!removedHooks && !removedStatusLine) return;

  // Replace a linked settings file inside a real project directory with the
  // sanitized local document. Unlinking the link never writes to its target.
  if (settingsStat.isSymbolicLink()) fs.unlinkSync(settingsPath);
  if (Object.keys(settings).length === 0) {
    if (!settingsStat.isSymbolicLink()) fs.unlinkSync(settingsPath);
  } else {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  if (fs.existsSync(settingsDir) && fs.readdirSync(settingsDir).length === 0) {
    fs.rmdirSync(settingsDir);
  }
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
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  let removed = false;
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
      if (keptHooks.length !== entry.hooks.length) removed = true;
      if (keptHooks.length > 0) cleanedEntries.push({ ...entry, hooks: keptHooks });
    }
    if (cleanedEntries.length > 0) hooks[eventName] = cleanedEntries;
    else delete hooks[eventName];
  }
  return removed;
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

function cleanupLegacyCodexProjectFiles(repoPath, obsDir) {
  const codexDir = path.join(repoPath, '.codex');
  let codexDirStat = null;
  try {
    codexDirStat = fs.lstatSync(codexDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!codexDirStat?.isDirectory()) return;

  const hooksPath = path.join(codexDir, 'hooks.json');
  const hooksBackupPath = `${hooksPath}.farmslot-backup`;
  const configPath = path.join(codexDir, 'config.toml');
  const configBackupPath = `${configPath}.farmslot-backup`;

  const lstatIfPresent = (filePath) => {
    try {
      return fs.lstatSync(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };
  const hooksStat = lstatIfPresent(hooksPath);
  const hooksBackupContent = fs.existsSync(hooksBackupPath)
    ? fs.readFileSync(hooksBackupPath, 'utf8')
    : null;
  if (hooksStat) {
    const { root, hooks } = readCodexHooksDocument(hooksPath);
    const removedHooks = removeFarmslotCodexHookEntries(hooks);
    if (removedHooks) {
      const sanitizedRoot = { ...root };
      if (Object.keys(hooks).length > 0) sanitizedRoot.hooks = hooks;
      else delete sanitizedRoot.hooks;

      const backupRoot = hooksBackupContent === null ? null : readJsonObject(hooksBackupPath);
      const matchesBackup =
        backupRoot !== null &&
        (JSON.stringify(sanitizedRoot) === JSON.stringify(backupRoot) ||
          JSON.stringify({ ...sanitizedRoot, hooks }) === JSON.stringify(backupRoot));
      if (hooksStat.isSymbolicLink()) fs.unlinkSync(hooksPath);
      if (matchesBackup) fs.writeFileSync(hooksPath, hooksBackupContent);
      else if (Object.keys(sanitizedRoot).length === 0) {
        if (!hooksStat.isSymbolicLink()) fs.unlinkSync(hooksPath);
      } else fs.writeFileSync(hooksPath, JSON.stringify(sanitizedRoot, null, 2) + '\n');
    }
  }
  if (fs.existsSync(hooksBackupPath)) {
    fs.renameSync(hooksBackupPath, path.join(obsDir, 'legacy-codex-hooks.farmslot-backup'));
  }

  const configStat = lstatIfPresent(configPath);
  const hasConfigBackup = fs.existsSync(configBackupPath);
  let configCleaned = !configStat;
  if (hasConfigBackup && configStat && !configStat.isSymbolicLink()) {
    const backupContent = fs.readFileSync(configBackupPath, 'utf8');
    const generatedContent = `${upsertCodexHooksFeature(backupContent)}\n`;
    const currentContent = fs.readFileSync(configPath, 'utf8');
    if (currentContent === generatedContent) {
      fs.writeFileSync(configPath, backupContent);
      configCleaned = true;
    } else {
      const restored = restoreLegacyCodexHooksFeature(currentContent, backupContent);
      if (restored !== null) {
        fs.writeFileSync(configPath, restored);
        configCleaned = true;
      }
    }
  }
  if (configCleaned && fs.existsSync(configBackupPath)) {
    fs.renameSync(configBackupPath, path.join(obsDir, 'legacy-codex-config.farmslot-backup'));
  }

  if (fs.existsSync(codexDir) && fs.readdirSync(codexDir).length === 0) fs.rmdirSync(codexDir);
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
  const settingsPath = path.join(obsDir, 'claude-settings.json');
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
  cleanupLegacyClaudeSettings(repoPath, obsDir);
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
  const hooksPath = path.join(obsDir, 'codex-hooks.json');
  fs.writeFileSync(hooksPath, '{}\n');
  mergeCodexHooks(hooksPath, markerPath, hookCommand);
  cleanupLegacyCodexProjectFiles(repoPath, obsDir);
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
