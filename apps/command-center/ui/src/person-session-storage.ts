import {
  parsePersonSessionAuth,
  type PersonSessionAuth,
  PersonSessionChangedError,
  type PersonSessionStorage,
  samePersonSessionAuthority,
} from '@farmslot/protocol';

import {
  getDesktopConnection,
  isDesktopClient,
  saveDesktopCredentials,
} from './desktop-connection.js';

/** One record per explicitly selected gateway set, including an ended-login marker. */
export class CommandCenterPersonSessionStorage implements PersonSessionStorage {
  private readonly key: string;
  private readonly desktop = isDesktopClient();
  private readonly desktopUrl = getDesktopConnection()?.url;
  private expected: string | null;
  private validating = false;
  private pending: PersonSessionAuth | null | undefined;

  constructor(urls: string[]) {
    this.key = `farmslot.gateway.person-session:${JSON.stringify([...new Set(urls)].sort())}`;
    this.expected = this.read();
  }

  get required(): boolean {
    return this.expected !== null;
  }

  async load(): Promise<PersonSessionAuth | null> {
    if (this.pending !== undefined) return this.pending;
    return this.synchronize();
  }

  private parse(raw: string | null): PersonSessionAuth | null {
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error('The saved device sign-in is invalid. Sign in again.');
    }
    if (value === null) return null;
    const auth = parsePersonSessionAuth(value);
    if (!auth) throw new Error('The saved device sign-in is invalid. Sign in again.');
    return auth;
  }

  private synchronize(): PersonSessionAuth | null {
    const raw = this.read();
    const current = this.parse(raw);
    if (raw !== this.expected) {
      const expected = this.parse(this.expected);
      if (!expected || !current || !samePersonSessionAuthority(expected, current))
        throw new PersonSessionChangedError();
      this.expected = raw;
    }
    return current;
  }

  beginValidation(): void {
    this.validating = true;
  }

  async save(value: PersonSessionAuth | null): Promise<void> {
    const parsed = value === null ? null : parsePersonSessionAuth(value);
    if (value !== null && !parsed) throw new Error('Invalid device sign-in storage value.');
    if (this.validating) {
      this.pending = parsed;
      return;
    }
    await this.persist(parsed);
  }

  async commit(): Promise<void> {
    if (this.pending !== undefined) await this.persist(this.pending);
    this.pending = undefined;
    this.validating = false;
  }

  private read(): string | null {
    if (!this.desktop) return localStorage.getItem(this.key);
    const connection = getDesktopConnection();
    if (connection?.url !== this.desktopUrl) throw new PersonSessionChangedError();
    return connection?.personSession === undefined
      ? null
      : JSON.stringify(connection.personSession);
  }

  private async persist(value: PersonSessionAuth | null): Promise<void> {
    const current = this.synchronize();
    const latest =
      value &&
      current &&
      samePersonSessionAuthority(value, current) &&
      Date.parse(current.session.lastRefreshedAt) > Date.parse(value.session.lastRefreshedAt)
        ? current
        : value;
    const serialized = JSON.stringify(latest);
    if (this.desktop) await saveDesktopCredentials({ personSession: latest });
    else localStorage.setItem(this.key, serialized);
    this.expected = serialized;
  }
}
