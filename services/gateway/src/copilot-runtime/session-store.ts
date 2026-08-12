import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';
import type { CopilotRuntimeSession } from '@farmslot/protocol';

export interface PersistedCopilotRuntime {
  schemaVersion: 1;
  session: CopilotRuntimeSession;
  transcriptOffset: number;
  paneId?: string;
  launchCommandHash?: string;
}

export interface CopilotAuditRecord {
  id: string;
  ts: string;
  action:
    | 'start'
    | 'reconnect'
    | 'send'
    | 'abort'
    | 'stop'
    | 'checkout-transition'
    | 'validation-command'
    | 'boundary-action';
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
      const parsed = JSON.parse(await readFile(this.sessionPath, 'utf8')) as PersistedCopilotRuntime;
      if (parsed.schemaVersion !== 1 || !parsed.session?.runtimeId) {
        throw new Error(`Unsupported Co-Pilot runtime store at ${this.sessionPath}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(record: PersistedCopilotRuntime): Promise<void> {
    await this.ensure();
    const temporaryPath = `${this.sessionPath}.tmp.${process.pid}.${randomUUID()}`;
    const redacted = redactCopilotValue(record) as PersistedCopilotRuntime;
    await writeFile(temporaryPath, `${JSON.stringify(redacted, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, this.sessionPath);
    await chmod(this.sessionPath, 0o600);
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
