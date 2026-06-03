// chat/chat-memory.ts — Copilot workspace: MEMORY.md + session summaries

import { existsSync, watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { type ChatMessage, Events } from '@farmslot/protocol';

import { farmslotRoot } from '../fleet/state.js';
import { callLLM } from '../llm/index.js';

// ─── File-watch cache for soul + memory ───
// Read from disk once; fs.watch invalidates on change.

let soulCache: string | null = null;
let skillsCache: string | null = null;
let memoryCache: string | null = null;

function watchFile(filePath: string, invalidate: () => void): void {
  try {
    const watcher = watch(filePath, () => {
      invalidate();
      watcher.close(); // re-watch happens on next read
    });
    watcher.on('error', () => {
      /* file removed/renamed — cache will be re-populated on next read */
    });
  } catch {
    /* file doesn't exist yet — no watch needed */
  }
}

const INITIAL_MEMORY = `# Farmslot Co-Pilot Memory

## Fleet Notes
<!-- Add notes about your fleet here. This file is read at the start of every session. -->

## User Preferences
<!-- Add preferences here. -->
`;

export function getCopilotDir(): string {
  // Dev default: {farmslotRoot}/copilot (local to repo, gitignored)
  // Prod: set FARMSLOT_COPILOT_DIR=~/.farmslot/copilot in .env
  return process.env.FARMSLOT_COPILOT_DIR ?? path.join(farmslotRoot, 'copilot');
}

export async function ensureCopilotDirs(): Promise<void> {
  const dir = getCopilotDir();
  await mkdir(path.join(dir, 'memory'), { recursive: true });
  await mkdir(path.join(dir, 'sessions'), { recursive: true });

  const memoryPath = path.join(dir, 'MEMORY.md');
  if (!existsSync(memoryPath)) {
    await writeFile(memoryPath, INITIAL_MEMORY, 'utf-8');
    console.log(`[chat] initialized MEMORY.md at ${memoryPath}`);
  }
}

export async function loadSoul(): Promise<string> {
  if (soulCache !== null) return soulCache;
  const soulPath = path.join(getCopilotDir(), 'SOUL.md');
  try {
    soulCache = await readFile(soulPath, 'utf-8');
    watchFile(soulPath, () => {
      soulCache = null;
    });
    return soulCache;
  } catch {
    soulCache = '';
    return '';
  }
}

export async function loadSkills(): Promise<string> {
  if (skillsCache !== null) return skillsCache;
  const skillsPath = path.join(getCopilotDir(), 'SKILLS.md');
  try {
    skillsCache = await readFile(skillsPath, 'utf-8');
    watchFile(skillsPath, () => {
      skillsCache = null;
    });
    return skillsCache;
  } catch {
    skillsCache = '';
    return '';
  }
}

export async function loadMemory(): Promise<string> {
  if (memoryCache !== null) return memoryCache;
  const memoryPath = path.join(getCopilotDir(), 'MEMORY.md');
  try {
    memoryCache = await readFile(memoryPath, 'utf-8');
    watchFile(memoryPath, () => {
      memoryCache = null;
    });
    console.log(`[chat] memory loaded: ${memoryCache.length} chars`);
    return memoryCache;
  } catch {
    memoryCache = '';
    return '';
  }
}

export async function saveMemory(content: string): Promise<void> {
  const memoryPath = path.join(getCopilotDir(), 'MEMORY.md');
  await writeFile(memoryPath, content, 'utf-8');
  memoryCache = content; // update cache immediately — watcher will fire but cache is already current
  console.log(`[chat] MEMORY.md saved: ${content.length} chars`);
}

export async function saveSessionMemory(
  sessionId: string,
  messages: ChatMessage[],
  broadcastFn: (event: string, payload: unknown) => void,
): Promise<string | undefined> {
  if (messages.length === 0) return undefined;

  const conversationText = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  let summary: string;
  let slug: string;
  try {
    const summaryResult = await callLLM({
      userPrompt: `Summarize this conversation in 2-3 sentences, focusing on key actions/decisions:\n\n${conversationText}`,
      maxTokens: 200,
    });
    summary = summaryResult.text.trim();

    const slugResult = await callLLM({
      userPrompt: `Generate a 3-5 word kebab-case slug for this session summary: "${summary}". Output ONLY the slug, no explanation.`,
      maxTokens: 30,
    });
    slug = slugResult.text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 50);
  } catch (err) {
    console.error(`[chat] summary generation failed: ${(err as Error).message}`);
    summary = `Session with ${messages.length} messages`;
    slug = 'session';
  }

  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const filename = `${date}-${slug}.md`;
  const savePath = path.join(getCopilotDir(), 'memory', filename);

  const content = `# Session: ${time}\n- Session ID: ${sessionId}\n\n## Summary\n${summary}\n`;
  await writeFile(savePath, content, 'utf-8');
  console.log(`[chat] session summary saved: ${savePath}`);

  broadcastFn(Events.CHAT_MEMORY_SAVED, { path: savePath, sessionId });
  return savePath;
}

export async function checkDailyAutosave(
  sessions: Array<{ id: string; messages: ChatMessage[]; lastSavedAt?: string }>,
  broadcastFn: (event: string, payload: unknown) => void,
): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const session of sessions) {
    if (session.messages.length === 0) continue;
    const lastSaved = session.lastSavedAt ? new Date(session.lastSavedAt).getTime() : 0;
    if (lastSaved < cutoff) {
      console.log(`[chat] daily auto-save for session ${session.id}`);
      await saveSessionMemory(session.id, session.messages, broadcastFn).catch((err) => {
        console.error(`[chat] auto-save failed: ${(err as Error).message}`);
      });
    }
  }
}
