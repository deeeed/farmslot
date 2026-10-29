import { Methods } from '@farmslot/protocol';

import { gateway } from './transport.js';

const leaf = { value: 'unrelated metadata' };
const a = { left: leaf, right: leaf };
const b = { left: a, right: a };
const c = { left: b, right: b };
const d = { left: c, right: c };
const e = { left: d, right: d };
const f = { left: e, right: e };
const g = { left: f, right: f };
const h = { left: g, right: g };
const i = { left: h, right: h };
const j = { left: i, right: i };
const k = { left: j, right: j };
const l = { left: k, right: k };
const m = { left: l, right: l };
const n = { left: m, right: m };
const o = { left: n, right: n };
const p = { left: o, right: o };
const q = { left: p, right: p };
const r = { left: q, right: q };
const s = { left: r, right: r };
const t = { left: s, right: s };
const selected = { method: Methods.RUN_LIST, unrelated: t };

export const sharedRead = () => gateway.request(selected.method, {});
