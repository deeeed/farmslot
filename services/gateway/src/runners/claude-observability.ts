import type { loadSlotVars } from '../core/config.js';
import { shellQuote } from '../core/tmux.js';

const HOOK_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';

function readStdin() {
  return fs.readFileSync(0, 'utf8');
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
  const record = {
    schemaVersion: 1,
    observedAt,
    timestamp: observedAt,
    hook_event_name: payload.hook_event_name || payload.event,
    event: payload.hook_event_name || payload.event,
    session_id: payload.session_id,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    permission_mode: payload.permission_mode,
    effort: payload.effort,
    tool_name: payload.tool_name,
    tmuxPane: process.env.TMUX_PANE || undefined,
    slotId: process.env.FARMSLOT_SLOT_ID || undefined,
    runner: 'claude',
  };
  fs.appendFileSync(logPath, JSON.stringify(record) + '\\n');
} catch (error) {
  // Observability must never block the runner. Claude records stderr for hook debugging.
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
  // Preserve the Claude UI if telemetry fails.
  console.error('[farmslot-statusline] ' + (error?.message || String(error)));
  process.stdout.write('fs');
}
`;

const SETTINGS_MERGE_SCRIPT = `const fs = require('node:fs');
const path = require('node:path');

const settingsPath = process.env.FARMSLOT_CLAUDE_SETTINGS;
if (!settingsPath) throw new Error('missing FARMSLOT_CLAUDE_SETTINGS');
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
let settings = {};
try {
  const raw = fs.readFileSync(settingsPath, 'utf8').trim();
  settings = raw ? JSON.parse(raw) : {};
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const hookCommand = 'FARMSLOT_OBS_DIR="\${FARMSLOT_OBS_DIR:-\${CLAUDE_PROJECT_DIR:-$PWD}/.observability}" node "\${FARMSLOT_OBS_DIR:-\${CLAUDE_PROJECT_DIR:-$PWD}/.observability}/bin/farmslot-observability-hook.mjs"';
const statusCommand = 'FARMSLOT_OBS_DIR="\${FARMSLOT_OBS_DIR:-\${CLAUDE_PROJECT_DIR:-$PWD}/.observability}" node "\${FARMSLOT_OBS_DIR:-\${CLAUDE_PROJECT_DIR:-$PWD}/.observability}/bin/farmslot-statusline.mjs"';
const hook = { type: 'command', command: hookCommand, timeout: 5 };
settings.hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {};
for (const eventName of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'StopFailure']) {
  const entries = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
  const cleaned = entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const hooks = Array.isArray(entry.hooks)
        ? entry.hooks.filter((candidate) => candidate?.command !== hookCommand)
        : [];
      return { ...entry, hooks };
    })
    .filter((entry) => !entry || typeof entry !== 'object' || (Array.isArray(entry.hooks) && entry.hooks.length > 0));
  cleaned.push({ matcher: '', hooks: [hook] });
  settings.hooks[eventName] = cleaned;
}
settings.statusLine = { type: 'command', command: statusCommand };
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\\n');
`;

function writeScript(pathValue: string, content: string): string {
  return `printf %s ${shellQuote(content)} > ${shellQuote(pathValue)}`;
}

export function buildClaudeObservabilityPrelude(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  repo: string,
  runtimeDir = '.agent',
): string {
  const settingsDir = `${repo}/.claude`;
  const obsDir = `${repo}/${runtimeDir}/.observability`;
  const compatObsDir = `${repo}/.observability`;
  const binDir = `${obsDir}/bin`;
  const settingsPath = `${settingsDir}/settings.local.json`;
  const hookPath = `${binDir}/farmslot-observability-hook.mjs`;
  const statuslinePath = `${binDir}/farmslot-statusline.mjs`;
  const mergePath = `${binDir}/farmslot-install-settings.cjs`;
  return [
    `cd ${shellQuote(repo)}`,
    `export FARMSLOT_OBS_DIR=${shellQuote(obsDir)}`,
    `export FARMSLOT_SLOT_ID=${shellQuote(vars.slotId)}`,
    `mkdir -p ${shellQuote(settingsDir)} ${shellQuote(binDir)} ${shellQuote(obsDir)}`,
    `printf %s farmslot > ${shellQuote(`${obsDir}/.farmslot-owned`)}`,
    `[ -L ${shellQuote(compatObsDir)} ] || [ -e ${shellQuote(compatObsDir)} ] || ln -s ${shellQuote(obsDir)} ${shellQuote(compatObsDir)}`,
    writeScript(hookPath, HOOK_SCRIPT),
    writeScript(statuslinePath, STATUSLINE_SCRIPT),
    writeScript(mergePath, SETTINGS_MERGE_SCRIPT),
    `FARMSLOT_CLAUDE_SETTINGS=${shellQuote(settingsPath)} node ${shellQuote(mergePath)}`,
  ].join(' && ');
}
