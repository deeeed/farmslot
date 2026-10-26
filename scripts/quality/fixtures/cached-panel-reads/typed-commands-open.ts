import { Methods } from '@farmslot/protocol';

import { gateway } from './transport.js';

// The same helper depth with an open method type must stay fail-closed at the bound.
class OpenSession {
  constructor(
    private readonly options: { request(method: string, params: unknown): Promise<unknown> },
  ) {}
  list(method: string) {
    return this.options.request(method, {});
  }
}

const session = new OpenSession({ request: (method, params) => gateway.request(method, params) });
const o1 = () => session.list(Methods.AUTH_SESSION_LIST);
const o2 = () => o1();
const o3 = () => o2();
const o4 = () => o3();
const o5 = () => o4();
const o6 = () => o5();
const o7 = () => o6();
const o8 = () => o7();
const o9 = () => o8();
const o10 = () => o9();
const o11 = () => o10();
const o12 = () => o11();
const o13 = () => o12();
export const deepOpenMethod = () => o13();

// A closed union that admits one registered read remains a cached-read transport.
export const typedCachedUnion = (method: typeof Methods.RUN_LIST | typeof Methods.RUN_CREATE) =>
  gateway.request(method, {});
