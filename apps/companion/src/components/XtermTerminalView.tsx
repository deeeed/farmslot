import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { StyleSheet, View } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';

import { colors, fonts } from '../lib/theme';

export type TerminalSize = { cols: number; rows: number };

export type XtermTerminalViewHandle = {
  reset: (text: string) => void;
  write: (text: string) => void;
  setStatus: (text: string) => void;
};

type XtermTerminalViewProps = {
  allowTouchKeyboard?: boolean;
  initialText: string;
  onInput: (data: string) => void;
  onResize: (size: TerminalSize) => void;
  readOnlyReason?: string | null;
};

type WebTerminalMessage =
  | { type: 'ready' }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'error'; message: string };

export const XtermTerminalView = forwardRef<XtermTerminalViewHandle, XtermTerminalViewProps>(
  function XtermTerminalView(
    { allowTouchKeyboard = false, initialText, onInput, onResize, readOnlyReason = null },
    ref,
  ) {
    const webViewRef = useRef<WebView>(null);
    const readyRef = useRef(false);
    const pendingMessagesRef = useRef<Array<{ type: string; payload: unknown }>>([]);
    const initialTextRef = useRef(initialText);
    initialTextRef.current = initialText;

    const sendMessage = useCallback((type: string, payload: unknown) => {
      const message = { type, payload };
      if (!readyRef.current) {
        pendingMessagesRef.current.push(message);
        return;
      }
      webViewRef.current?.injectJavaScript(
        `window.FarmSlotTerminal && window.FarmSlotTerminal.receive(${JSON.stringify(
          message,
        )}); true;`,
      );
    }, []);

    const flushPendingMessages = useCallback(() => {
      const pending = pendingMessagesRef.current.splice(0);
      for (const message of pending) sendMessage(message.type, message.payload);
    }, [sendMessage]);

    useImperativeHandle(
      ref,
      () => ({
        reset: (text: string) => sendMessage('reset', text),
        write: (text: string) => sendMessage('write', text),
        setStatus: (text: string) => sendMessage('status', text),
      }),
      [sendMessage],
    );

    const html = useMemo(() => terminalHtml(), []);

    useEffect(() => {
      sendMessage('touchKeyboard', allowTouchKeyboard);
    }, [allowTouchKeyboard, sendMessage]);

    useEffect(() => {
      sendMessage('readOnly', readOnlyReason ?? '');
    }, [readOnlyReason, sendMessage]);

    const handleMessage = useCallback(
      (event: WebViewMessageEvent) => {
        let message: WebTerminalMessage;
        try {
          message = JSON.parse(event.nativeEvent.data) as WebTerminalMessage;
        } catch (error) {
          sendMessage(
            'status',
            `Ignored invalid terminal web message: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
        if (message.type === 'ready') {
          readyRef.current = true;
          sendMessage('reset', initialTextRef.current);
          flushPendingMessages();
          return;
        }
        if (message.type === 'input') {
          if (!readOnlyReason) onInput(message.data);
          return;
        }
        if (message.type === 'resize') {
          onResize({ cols: message.cols, rows: message.rows });
          return;
        }
        if (message.type === 'error') {
          sendMessage('status', message.message);
        }
      },
      [flushPendingMessages, onInput, onResize, readOnlyReason, sendMessage],
    );

    return (
      <View style={styles.container}>
        <WebView
          ref={webViewRef}
          source={{ html }}
          originWhitelist={['*']}
          javaScriptEnabled
          scrollEnabled={false}
          nestedScrollEnabled
          keyboardDisplayRequiresUserAction
          onMessage={handleMessage}
          style={styles.webView}
          containerStyle={styles.webViewContainer}
          setBuiltInZoomControls={false}
          textZoom={100}
        />
      </View>
    );
  },
);

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#000',
    flex: 1,
  },
  webView: {
    backgroundColor: '#000',
    flex: 1,
  },
  webViewContainer: {
    backgroundColor: '#000',
    flex: 1,
  },
});

function terminalHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css" />
  <style>
    html, body, #terminal {
      width: 100%;
      height: 100%;
      margin: 0;
      background: #000;
    }
    html, body {
      overflow: hidden;
    }
    body {
      -webkit-user-select: text;
      user-select: text;
      color: ${colors.textPrimary};
      font-family: ${JSON.stringify(fonts.mono)}, Menlo, Monaco, Consolas, monospace;
    }
    #fallback {
      box-sizing: border-box;
      display: none;
      height: 100%;
      margin: 0;
      overflow: auto;
      padding: 10px;
      white-space: pre-wrap;
      word-break: break-word;
      color: ${colors.textPrimary};
      background: #000;
      font: 11px/1.35 ${JSON.stringify(fonts.mono)}, Menlo, Monaco, Consolas, monospace;
    }
    #fallbackInput {
      box-sizing: border-box;
      display: none;
      position: absolute;
      left: 8px;
      right: 8px;
      bottom: max(8px, env(safe-area-inset-bottom));
      z-index: 5;
      min-height: 38px;
      padding: 8px 10px;
      border: 1px solid ${colors.accent};
      border-radius: 8px;
      outline: none;
      color: ${colors.textPrimary};
      background: rgba(18,18,26,0.96);
      font: 12px/1.3 ${JSON.stringify(fonts.mono)}, Menlo, Monaco, Consolas, monospace;
    }
    #status, #readonly {
      position: absolute;
      right: 8px;
      z-index: 4;
      max-width: 70%;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(18,18,26,0.82);
      color: ${colors.textMuted};
      font: 10px/1.2 ${JSON.stringify(fonts.mono)}, Menlo, Monaco, Consolas, monospace;
      pointer-events: none;
    }
    #status {
      top: 8px;
    }
    #readonly {
      bottom: max(8px, env(safe-area-inset-bottom));
      display: none;
      opacity: 0.55;
    }
    .xterm {
      height: 100%;
      padding: 8px;
      touch-action: none;
    }
    .xterm-viewport {
      overflow-y: scroll !important;
      -webkit-overflow-scrolling: touch;
      touch-action: none;
    }
    .xterm-screen {
      touch-action: none;
    }
    .xterm-viewport::-webkit-scrollbar {
      width: 6px;
    }
    .xterm-viewport::-webkit-scrollbar-thumb {
      background: ${colors.textMuted};
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <pre id="fallback"></pre>
  <textarea id="fallbackInput" rows="1" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="type command…"></textarea>
  <div id="status">loading xterm…</div>
  <div id="readonly"></div>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.min.js"></script>
  <script>
    (function () {
      var term = null;
      var fitAddon = null;
      var ready = false;
      var fallback = document.getElementById('fallback');
      var fallbackInput = document.getElementById('fallbackInput');
      var status = document.getElementById('status');
      var terminalElement = document.getElementById('terminal');
      var queue = [];
      var readOnly = false;
      var allowTouchKeyboard = false;
      var readonly = document.getElementById('readonly');
      var lastSize = { cols: 80, rows: 24 };
      var touchScrollY = null;
      var touchScrollDistance = 0;
      var touchScrollRemainderRows = 0;
      var lastTouchEndAt = 0;
      var TOUCH_SCROLL_MOVE_THRESHOLD = 4;
      var TOUCH_SCROLL_LINE_MULTIPLIER = 1.35;
      var TOUCH_FOCUS_SUPPRESS_MS = 800;

      function post(message) {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(message));
      }

      function setStatus(text) {
        status.textContent = text || '';
        status.style.display = text ? 'block' : 'none';
      }

      function setReadOnly(text) {
        readOnly = Boolean(text);
        readonly.textContent = text || '';
        readonly.style.display = text ? 'block' : 'none';
        if (fallbackInput) {
          fallbackInput.disabled = readOnly;
          fallbackInput.placeholder = readOnly ? text : 'type command…';
        }
        if (term) {
          term.options.disableStdin = readOnly;
          term.options.cursorBlink = !readOnly;
        }
      }

      function writeFallback(text, replace) {
        fallback.style.display = 'block';
        fallbackInput.style.display = readOnly ? 'none' : 'block';
        if (replace) fallback.textContent = text || '';
        else fallback.textContent += text || '';
        fallback.scrollTop = fallback.scrollHeight;
      }

      function resetTouchScroll() {
        touchScrollY = null;
        touchScrollDistance = 0;
        touchScrollRemainderRows = 0;
      }

      function terminalViewport() {
        return terminalElement.querySelector('.xterm-viewport');
      }

      function terminalLineHeight() {
        var row = terminalElement.querySelector('.xterm-rows > div');
        if (row) {
          var rect = row.getBoundingClientRect();
          if (rect.height > 0) return rect.height;
        }
        var viewport = terminalViewport();
        if (viewport && term && term.rows > 0) {
          return Math.max(1, viewport.clientHeight / term.rows);
        }
        return 14;
      }

      function terminalCellFromPoint(clientX, clientY) {
        var screen = terminalElement.querySelector('.xterm-screen') || terminalElement;
        var rect = screen.getBoundingClientRect();
        var lineHeight = terminalLineHeight();
        var cellWidth = term && term.cols > 0 ? Math.max(1, rect.width / term.cols) : 8;
        return {
          col: Math.max(
            1,
            Math.min(term ? term.cols : 80, Math.floor((clientX - rect.left) / cellWidth) + 1)
          ),
          row: Math.max(
            1,
            Math.min(term ? term.rows : 24, Math.floor((clientY - rect.top) / lineHeight) + 1)
          )
        };
      }

      function activeBufferMetric(name, fallbackName) {
        var buffer = term && term.buffer && term.buffer.active;
        if (!buffer) return 0;
        if (typeof buffer[name] === 'number') return buffer[name];
        if (fallbackName && typeof buffer[fallbackName] === 'number') return buffer[fallbackName];
        return 0;
      }

      function canScrollXtermRows(rows) {
        if (!term || rows === 0) return false;
        var viewportY = activeBufferMetric('viewportY', 'ydisp');
        var baseY = activeBufferMetric('baseY', 'ybase');
        if (rows < 0) return viewportY > 0;
        return viewportY < baseY;
      }

      function rowsFromPixelDelta(pixelDelta) {
        if (!term) return 0;
        var lineHeight = terminalLineHeight();
        var rawRows = (pixelDelta / lineHeight) * TOUCH_SCROLL_LINE_MULTIPLIER + touchScrollRemainderRows;
        var wholeRows = rawRows > 0 ? Math.floor(rawRows) : Math.ceil(rawRows);
        touchScrollRemainderRows = rawRows - wholeRows;
        return wholeRows;
      }

      function scrollTerminalByRows(rows) {
        if (!term || rows === 0) return false;
        term.scrollLines(rows);
        return true;
      }

      function wheelInputForRows(rows, clientX, clientY) {
        if (!term || rows === 0 || readOnly) return '';
        var pos = terminalCellFromPoint(clientX, clientY);
        var button = rows < 0 ? 64 : 65;
        var count = Math.max(1, Math.min(8, Math.abs(rows)));
        var sequence = '';
        for (var i = 0; i < count; i++) {
          sequence += '\\x1b[<' + button + ';' + pos.col + ';' + pos.row + 'M';
        }
        return sequence;
      }

      function scrollTerminalByPixels(pixelDelta, clientX, clientY) {
        var rows = rowsFromPixelDelta(pixelDelta);
        if (rows === 0) return false;
        if (canScrollXtermRows(rows)) return scrollTerminalByRows(rows);
        var wheelInput = wheelInputForRows(rows, clientX, clientY);
        if (!wheelInput) return false;
        post({ type: 'input', data: wheelInput });
        return true;
      }

      function suppressTouchDefault(event) {
        event.stopPropagation();
        event.preventDefault();
      }

      function handleTerminalTouchStart(event) {
        if (!term || event.touches.length !== 1) return;
        if (!allowTouchKeyboard) suppressTouchDefault(event);
        touchScrollY = event.touches[0].clientY;
        touchScrollDistance = 0;
        touchScrollRemainderRows = 0;
      }

      function handleTerminalTouchMove(event) {
        if (!term || touchScrollY == null || event.touches.length !== 1) return;
        suppressTouchDefault(event);
        var nextY = event.touches[0].clientY;
        var deltaY = touchScrollY - nextY;
        touchScrollY = nextY;
        if (Math.abs(deltaY) < 1) return;
        touchScrollDistance += Math.abs(deltaY);
        if (touchScrollDistance < TOUCH_SCROLL_MOVE_THRESHOLD) return;
        if (scrollTerminalByPixels(deltaY, event.touches[0].clientX, event.touches[0].clientY)) return;
        term.scrollLines(deltaY > 0 ? 1 : -1);
      }

      function handleTerminalTouchEnd(event) {
        if (!allowTouchKeyboard) {
          suppressTouchDefault(event);
          lastTouchEndAt = Date.now();
        }
        resetTouchScroll();
      }

      function handleTerminalTouchCancel(event) {
        suppressTouchDefault(event);
        lastTouchEndAt = Date.now();
        resetTouchScroll();
      }

      function suppressSyntheticTouchClick(event) {
        if (Date.now() - lastTouchEndAt > TOUCH_FOCUS_SUPPRESS_MS) return;
        event.stopPropagation();
        event.preventDefault();
      }

      function suppressTouchPointerFocus(event) {
        if (allowTouchKeyboard) return;
        if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
        event.stopPropagation();
        event.preventDefault();
      }

      function handleTerminalWheel(event) {
        if (!term) return;
        if (Math.abs(event.deltaY) < 1) return;
        if (scrollTerminalByPixels(event.deltaY, event.clientX, event.clientY)) {
          event.stopPropagation();
          event.preventDefault();
        }
      }

      function fitAndReport() {
        if (!term || !fitAddon) return;
        try {
          fitAddon.fit();
          var next = { cols: term.cols || 80, rows: term.rows || 24 };
          if (next.cols !== lastSize.cols || next.rows !== lastSize.rows) {
            lastSize = next;
            post({ type: 'resize', cols: next.cols, rows: next.rows });
          }
        } catch (error) {
          post({ type: 'error', message: 'xterm fit failed: ' + String(error && error.message || error) });
        }
      }

      function receive(message) {
        if (!ready) {
          queue.push(message);
          return;
        }
        var payload = message.payload == null ? '' : String(message.payload);
        if (message.type === 'reset') {
          if (term) {
            term.clear();
            if (payload) term.write(payload.replace(/\\n/g, '\\r\\n'));
          } else {
            writeFallback(payload, true);
          }
          return;
        }
        if (message.type === 'write') {
          if (term) term.write(payload);
          else writeFallback(payload, false);
          return;
        }
        if (message.type === 'status') {
          setStatus(payload);
          return;
        }
        if (message.type === 'readOnly') {
          setReadOnly(payload);
          return;
        }
        if (message.type === 'touchKeyboard') {
          allowTouchKeyboard = message.payload === true;
        }
      }

      window.FarmSlotTerminal = { receive: receive };

      function markReady() {
        ready = true;
        setStatus('');
        post({ type: 'ready' });
        var pending = queue.splice(0);
        pending.forEach(receive);
      }

      function bootFallback(reason) {
        term = null;
        fitAddon = null;
        fallbackInput.style.display = readOnly ? 'none' : 'block';
        setStatus(reason);
        markReady();
      }

      function bootXterm() {
        if (!window.Terminal) {
          bootFallback('xterm unavailable');
          return;
        }
        term = new window.Terminal({
          cursorBlink: !readOnly,
          convertEol: false,
          fontFamily: ${JSON.stringify(fonts.mono + ', Menlo, Monaco, Consolas, monospace')},
          fontSize: 11,
          disableStdin: readOnly,
          lineHeight: 1.18,
          scrollback: 5000,
          theme: {
            background: '#000000',
            foreground: ${JSON.stringify(colors.textPrimary)},
            cursor: ${JSON.stringify(colors.accent)},
            selectionBackground: '#6366f144',
            black: '#0a0a0f',
            red: ${JSON.stringify(colors.statusFail)},
            green: ${JSON.stringify(colors.statusOk)},
            yellow: ${JSON.stringify(colors.statusWarn)},
            blue: ${JSON.stringify(colors.accent)},
            magenta: '#8b5cf6',
            cyan: '#06b6d4',
            white: ${JSON.stringify(colors.textPrimary)}
          }
        });
        if (window.FitAddon && window.FitAddon.FitAddon) {
          fitAddon = new window.FitAddon.FitAddon();
          term.loadAddon(fitAddon);
        }
        term.open(terminalElement);
        term.onData(function (data) {
          if (!readOnly) post({ type: 'input', data: data });
        });
        terminalElement.addEventListener('touchstart', handleTerminalTouchStart, { passive: false, capture: true });
        terminalElement.addEventListener('touchmove', handleTerminalTouchMove, { passive: false, capture: true });
        terminalElement.addEventListener('touchend', handleTerminalTouchEnd, { passive: false, capture: true });
        terminalElement.addEventListener('touchcancel', handleTerminalTouchCancel, { passive: false, capture: true });
        terminalElement.addEventListener('pointerdown', suppressTouchPointerFocus, { passive: false, capture: true });
        terminalElement.addEventListener('pointerup', suppressTouchPointerFocus, { passive: false, capture: true });
        terminalElement.addEventListener('click', suppressSyntheticTouchClick, { passive: false, capture: true });
        terminalElement.addEventListener('mousedown', suppressSyntheticTouchClick, { passive: false, capture: true });
        terminalElement.addEventListener('wheel', handleTerminalWheel, { passive: false, capture: true });
        requestAnimationFrame(function () {
          fitAndReport();
          markReady();
        });
        if (window.ResizeObserver) {
          new ResizeObserver(function () { requestAnimationFrame(fitAndReport); }).observe(document.body);
        } else {
          window.addEventListener('resize', fitAndReport);
        }
      }

      window.addEventListener('error', function (event) {
        post({ type: 'error', message: String(event.message || 'web terminal error') });
      });

      if (fallbackInput) {
        fallbackInput.addEventListener('keydown', function (event) {
          if (readOnly) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            var value = fallbackInput.value;
            fallbackInput.value = '';
            if (value) post({ type: 'input', data: value + '\\r' });
          }
        });
      }

      setTimeout(bootXterm, 0);
    })();
  </script>
</body>
</html>`;
}
