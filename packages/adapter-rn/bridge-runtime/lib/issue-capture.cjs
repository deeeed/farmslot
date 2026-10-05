'use strict';

// In-app issue buffer for a React Native (Hermes) runtime: the arm snippet hooks
// console.warn/error, global errors and unhandled rejections into a bounded
// buffer; the collect snippet drains it. Callers evaluate both over CDP.

// Installed into the Hermes runtime via Runtime.evaluate. Returns a string
// so callers can embed it directly into eval expressions. Keeps the hook
// idempotent and bounded (500-entry cap).
function buildArmSnippet() {
  return `(() => {
  var g = globalThis;
  if (g.__AGENTIC_ISSUES_INSTALLED__) { return { installed: true, reason: 'already-installed' }; }
  g.__AGENTIC_ISSUES__ = [];
  g.__AGENTIC_ISSUES_CAP__ = 500;
  var push = function (entry) {
    try {
      if (g.__AGENTIC_ISSUES__.length < g.__AGENTIC_ISSUES_CAP__) {
        g.__AGENTIC_ISSUES__.push(entry);
      }
    } catch (_e) {}
  };
  ['warn', 'error'].forEach(function (k) {
    var orig = console[k] && console[k].bind(console);
    if (!orig) return;
    console[k] = function () {
      var args = Array.prototype.slice.call(arguments);
      try {
        var text = args.map(function (a) {
          if (a && a.stack) return String(a.stack);
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch (_e) { return String(a); }
        }).join(' ');
        push({ t: Date.now(), level: k, text: text });
      } catch (_e) {}
      return orig.apply(console, args);
    };
  });
  if (typeof g.addEventListener === 'function') {
    try {
      g.addEventListener('error', function (e) {
        var err = e && (e.error || e.message);
        var text = err && err.stack ? err.stack : String(err || e);
        push({ t: Date.now(), level: 'exception', text: text });
      });
      g.addEventListener('unhandledrejection', function (e) {
        var r = e && e.reason;
        var text = r && r.stack ? r.stack : String(r || e);
        push({ t: Date.now(), level: 'exception', text: text });
      });
    } catch (_e) {}
  }
  var ep = g.ErrorUtils;
  if (ep && typeof ep.setGlobalHandler === 'function') {
    try {
      var priorHandler = typeof ep.getGlobalHandler === 'function' ? ep.getGlobalHandler() : null;
      ep.setGlobalHandler(function (err, isFatal) {
        try {
          var text = err && err.stack ? err.stack : String(err);
          push({ t: Date.now(), level: 'exception', text: (isFatal ? '[FATAL] ' : '') + text });
        } catch (_e) {}
        if (typeof priorHandler === 'function') {
          try { priorHandler(err, isFatal); } catch (_e) {}
        }
      });
    } catch (_e) {}
  }
  g.__AGENTIC_ISSUES_INSTALLED__ = true;
  return { installed: true };
})()`;
}

function buildCollectSnippet() {
  return `(() => {
  var g = globalThis;
  var buf = g.__AGENTIC_ISSUES__ || [];
  var snapshot = buf.slice();
  g.__AGENTIC_ISSUES__ = [];
  return { count: snapshot.length, entries: snapshot };
})()`;
}

module.exports = {
  buildArmSnippet,
  buildCollectSnippet,
};
