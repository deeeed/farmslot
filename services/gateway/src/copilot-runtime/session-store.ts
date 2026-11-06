import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CopilotRuntimeSession } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

export interface PersistedCopilotRuntime {
  schemaVersion: 1;
  session: CopilotRuntimeSession;
  nativeOwnerPrincipalId?: string;
  pendingNativeSessionId?: string;
  stoppedNativeSessionId?: string;
}

export interface CopilotAuditRecord {
  id: string;
  ts: string;
  action: 'start' | 'configure' | 'reconnect' | 'send' | 'abort' | 'stop' | 'checkout-transition';
  runtimeId: string;
  safetyTier: string;
  checkout: string;
  branch: string;
  head: string;
  detail?: Record<string, unknown>;
}

const SECRET_KEY = /(?:secret|token|password|credential|authorization|api[_-]?key)/i;
const SECRET_VALUE = /(?:Bearer\s+\S+|(?:sk|ghp|github_pat|fs)_[A-Za-z0-9_-]{12,})/gi;

export function redactCopilotValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redactCopilotValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactCopilotValue(child, childKey),
      ]),
    );
  }
  return value;
}

export class CopilotRuntimeStore {
  readonly dir: string;
  readonly sessionPath: string;
  readonly auditPath: string;
  readonly rawTranscriptPath: string;
  readonly bootstrapPath: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(home = farmslotHome()) {
    this.dir = path.join(home, 'copilot-runtime');
    this.sessionPath = path.join(this.dir, 'session.json');
    this.auditPath = path.join(this.dir, 'audit.jsonl');
    this.rawTranscriptPath = path.join(this.dir, 'tmux-transcript.log');
    this.bootstrapPath = path.join(this.dir, 'bootstrap.md');
  }

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
  }

  async load(): Promise<PersistedCopilotRuntime | null> {
    try {
      const parsed = JSON.parse(
        await readFile(this.sessionPath, 'utf8'),
      ) as PersistedCopilotRuntime;
      if (parsed.schemaVersion !== 1 || !parsed.session?.runtimeId) {
        throw new Error(`Unsupported Co-Pilot runtime store at ${this.sessionPath}`);
      }
      // Old immutable transcripts remain on disk. They are never rebound as a native identity.
      for (const field of ['tmuxTarget', 'terminalWorker', 'transcriptId'])
        Reflect.deleteProperty(parsed.session, field);
      return {
        schemaVersion: 1,
        session: parsed.session,
        ...(parsed.nativeOwnerPrincipalId
          ? { nativeOwnerPrincipalId: parsed.nativeOwnerPrincipalId }
          : {}),
        ...(parsed.stoppedNativeSessionId
          ? { stoppedNativeSessionId: parsed.stoppedNativeSessionId }
          : {}),
        ...(parsed.pendingNativeSessionId
          ? { pendingNativeSessionId: parsed.pendingNativeSessionId }
          : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  save(record: PersistedCopilotRuntime): Promise<void> {
    const snapshot = redactCopilotValue(record);
    const write = async () => {
      await this.ensure();
      const temporaryPath = `${this.sessionPath}.tmp.${process.pid}.${randomUUID()}`;
      const file = await open(temporaryPath, 'w', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.sessionPath);
      const directory = await open(this.dir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    // A new explicit write may recover from a previous failed write; that caller still
    // received its error. Successful writes cannot overtake one another.
    this.writing = this.writing.then(write, write);
    return this.writing;
  }

  async writeBootstrap(content: string): Promise<void> {
    await this.ensure();
    const temporaryPath = `${this.bootstrapPath}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(temporaryPath, String(redactCopilotValue(content)), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, this.bootstrapPath);
    await chmod(this.bootstrapPath, 0o600);
  }

  async appendAudit(record: CopilotAuditRecord): Promise<void> {
    await this.ensure();
    const redacted = redactCopilotValue(record);
    await appendFile(this.auditPath, `${JSON.stringify(redacted)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.auditPath, 0o600);
  }
}
