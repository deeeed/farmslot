import { Methods } from '@farmslot/protocol';

import { gateway } from './transport.js';

type SessionMethod = typeof Methods.AUTH_SESSION_REFRESH | typeof Methods.AUTH_SESSION_LIST;

// A session client's refresh loop whose transport type admits only uncached commands.
class TypedSession {
  constructor(
    private readonly options: { request(method: SessionMethod, params: unknown): Promise<unknown> },
  ) {}
  async access(): Promise<unknown> {
    return this.adopt(await this.options.request(Methods.AUTH_SESSION_REFRESH, {}));
  }
  list(method: SessionMethod) {
    return this.withAccess(() => this.options.request(method, {}));
  }
  private async withAccess<T>(operation: () => Promise<T>): Promise<T> {
    await this.access();
    return operation();
  }
  private adopt(grant: unknown) {
    this.schedule();
    return grant;
  }
  private schedule() {
    setTimeout(() => void this.access(), 1_000);
  }
}

const session = new TypedSession({ request: (method, params) => gateway.request(method, params) });
const h1 = () => session.list(Methods.AUTH_SESSION_LIST);
const h2 = () => h1();
const h3 = () => h2();
const h4 = () => h3();
const h5 = () => h4();
const h6 = () => h5();
const h7 = () => h6();
const h8 = () => h7();
const h9 = () => h8();
const h10 = () => h9();
const h11 = () => h10();
const h12 = () => h11();
const h13 = () => h12();
export const deepTypedCommand = () => h13();
