// Passive render/DOM counters. Wrappers forward all original arguments and results.
// Controlled cycles invoke the existing cache's real read/retry path, never set UI data.
const key = Symbol.for('farmslot.background-sync-measure');
if (!globalThis[key]) {
  const entries = new Map(),
    restore = [],
    observers = [];
  let active = false,
    network = [];
  const card = () =>
    document.querySelector(`a.fa-active-run[href^="#slot/${SLOT_ID}"]`)?.parentElement;
  const find = (name) => {
    if (name === 'pinned') return card();
    if (name === 'app') return document.querySelector('farm-app');
    if (name === 'runs') return document.querySelector('run-list');
    if (name === 'slot') return document.querySelector('slot-view');
    return (
      document.querySelector('run-list')?.shadowRoot?.querySelector('run-detail') ??
      document.querySelector('run-detail')
    );
  };
  const snapshot = (name) => {
    const node = find(name);
    return {
      node,
      text: node ? (node.shadowRoot ?? node).textContent : '',
      bounds: node
        ? (() => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          })()
        : null,
    };
  };
  function wrap(object, method, callback) {
    const original = object?.[method];
    if (typeof original !== 'function') return;
    const own = Object.getOwnPropertyDescriptor(object, method);
    object[method] = function (...args) {
      callback(...args);
      return Reflect.apply(original, this, args);
    };
    restore.push(() => {
      if (own) Object.defineProperty(object, method, own);
      else delete object[method];
    });
  }
  function attach() {
    for (const name of ['app', 'runs', 'slot', 'detail', 'pinned']) {
      const node = find(name);
      if (!node || entries.get(name)?.node === node) continue;
      const metric = {
        node,
        renders: 0,
        descendantRenders: 0,
        added: 0,
        removed: 0,
        elementsAdded: 0,
        elementsRemoved: 0,
        text: 0,
        attributes: 0,
        keys: [],
      };
      entries.set(name, metric);
      if (name !== 'pinned') {
        wrap(node, 'willUpdate', (changed) => {
          if (active) metric.keys.push([...changed.keys()].map(String));
        });
        wrap(node, 'render', () => {
          if (active) metric.renders++;
        });
      } else {
        const app = find('app'),
          method = 'renderPinnedSlotShortcut';
        const original = app[method],
          own = Object.getOwnPropertyDescriptor(app, method);
        app[method] = function (...args) {
          const result = Reflect.apply(original, this, args);
          const counted = args[0]?.slotId === SLOT_ID;
          // A guarded template renders only when Lit calls its original callback.
          if (
            result?._$litDirective$ &&
            Array.isArray(result.values?.[0]) &&
            typeof result.values?.[1] === 'function'
          ) {
            const callback = result.values[1];
            return {
              ...result,
              values: [
                result.values[0],
                (...values) => {
                  if (active && counted) metric.renders++;
                  return Reflect.apply(callback, undefined, values);
                },
              ],
            };
          }
          if (active && counted) metric.renders++;
          return result;
        };
        restore.push(() => {
          if (own) Object.defineProperty(app, method, own);
          else delete app[method];
        });
      }
      const observer = new MutationObserver((records) => {
        if (!active) return;
        for (const r of records) {
          if (r.type === 'childList') {
            metric.added += r.addedNodes.length;
            metric.removed += r.removedNodes.length;
            metric.elementsAdded += [...r.addedNodes].filter((n) => n.nodeType === 1).length;
            metric.elementsRemoved += [...r.removedNodes].filter((n) => n.nodeType === 1).length;
          } else if (r.type === 'characterData') metric.text++;
          else metric.attributes++;
        }
      });
      const scan = (root) => {
        observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
        for (const child of root.querySelectorAll('*'))
          if (child.shadowRoot) {
            wrap(child, 'render', () => {
              if (active) metric.descendantRenders++;
            });
            scan(child.shadowRoot);
          }
      };
      scan(node.shadowRoot ?? node);
      observers.push(observer);
    }
  }
  const { gateway } = await import('/src/gateway-client.ts');
  const request = gateway.requestResource;
  gateway.requestResource = function (method, ...args) {
    if (active) network.push(method);
    return Reflect.apply(request, this, [method, ...args]);
  };
  restore.push(() => {
    gateway.requestResource = request;
  });
  const frames = () =>
    new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  const { getResourceCache } = await import('/src/resource-cache.ts');
  const queries = () => {
    const all = new Map();
    const cache = getResourceCache();
    if (!cache) return [];
    const stop = cache.observeSync(
      () => {},
      (q) => {
        all.set(q.id, q);
        return false;
      },
    );
    stop();
    return [...all.values()];
  };
  globalThis[key] = {
    inspect() {
      attach();
      return {
        visibility: document.visibilityState,
        connection: gateway.connectionState,
        cacheReady: Boolean(getResourceCache()),
        queries: queries().map((q) => ({
          method: q.method,
          keys: Object.keys(q.params ?? {}),
          hasData: getResourceCache().read(q).data !== undefined,
          status: getResourceCache().read(q).status,
        })),
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        spacing: {
          notification: document.querySelector('farm-notification-tray')?.getBoundingClientRect()
            .height,
          filters: document.querySelector('global-filter-bar')?.getBoundingClientRect().height,
          rows: [...(find('runs')?.shadowRoot?.querySelectorAll('.work-inventory-row') ?? [])]
            .slice(0, 8)
            .map((row) => ({
              height: row.getBoundingClientRect().height,
              cells: [...row.children].map((c) => ({
                className: c.className,
                height: c.getBoundingClientRect().height,
              })),
            })),
        },
        geometry: Object.fromEntries(
          ['app', 'runs', 'slot', 'detail', 'pinned'].map((n) => [n, snapshot(n).bounds]),
        ),
      };
    },
    async cycle(methods, watchMs = 0) {
      if (document.visibilityState !== 'visible') throw Error('Keep the measured tab visible');
      attach();
      const cache = getResourceCache();
      const selected = queries().filter(
        (q) => methods.includes(q.method) && cache.read(q).data !== undefined,
      );
      if (!selected.length && !watchMs) throw Error('No observed queries for ' + methods.join(','));
      const before = selected.map((q) => JSON.stringify(cache.read(q).data));
      const allBefore = queries().map((q) => ({ q, json: JSON.stringify(cache.read(q).data) }));
      const starts = new Map([...entries.keys()].map((n) => [n, snapshot(n)]));
      for (const m of entries.values()) {
        m.descendantRenders =
          m.renders =
          m.added =
          m.removed =
          m.elementsAdded =
          m.elementsRemoved =
          m.text =
          m.attributes =
            0;
        m.keys = [];
      }
      network = [];
      active = true;
      try {
        if (watchMs) await new Promise((resolve) => setTimeout(resolve, watchMs));
        else await Promise.all(selected.map((q) => cache.retry(q)));
        await frames();
        await frames();
      } finally {
        active = false;
      }
      const same = selected.map((q, i) => ({
        method: q.method,
        equalData: before[i] === JSON.stringify(cache.read(q).data),
        status: cache.read(q).status,
      }));
      const metrics = Object.fromEntries(
        [...entries].map(([name, m]) => {
          const end = snapshot(name),
            start = starts.get(name);
          return [
            name,
            {
              renders: m.renders,
              descendantRenders: m.descendantRenders,
              nodesAdded: m.added,
              nodesRemoved: m.removed,
              elementsAdded: m.elementsAdded,
              elementsRemoved: m.elementsRemoved,
              textUpdates: m.text,
              attributes: m.attributes,
              changedKeys: m.keys,
              identityKept: start?.node === end.node,
              textEqual: start?.text === end.text,
              bounds: end.bounds,
            },
          ];
        }),
      );
      const changedObservedQueries = allBefore
        .filter(({ q, json }) => json !== JSON.stringify(cache.read(q).data))
        .map(({ q }) => ({ method: q.method, keys: Object.keys(q.params ?? {}) }));
      return { queries: same, changedObservedQueries, network, metrics };
    },
    stop() {
      active = false;
      for (const o of observers) o.disconnect();
      for (const fn of restore.reverse()) fn();
      delete globalThis[key];
    },
  };
}
return globalThis[key].inspect();
