# capture-helper — Generic macOS Window Capture

Captures a macOS window and outputs raw H.264 Annex B to stdout.
Part of the device screen streaming pipeline (see [ADR-012](../../docs/adr/012-device-screen-streaming.md)).

## Build

```bash
./build.sh
```

Requires macOS 13.0+ and Xcode command-line tools. No Package.swift or Xcode project needed — single `swiftc` invocation.

## Usage

```bash
# Capture a specific window by title substring
./capture-helper --window-name mm-1 > /tmp/capture.h264

# Restrict title matching to a given app
./capture-helper --app-name Simulator --window-name mm-1 > /tmp/capture.h264

# Custom frame rate and resolution
./capture-helper --max-fps 30 --max-size 1080 > /tmp/capture.h264

# Pipe directly to ffplay for live preview
./capture-helper | ffplay -f h264 -

# List available windows (JSON to stderr)
./capture-helper --list-windows
```

### Options

| Flag                     | Default                   | Description                                             |
| ------------------------ | ------------------------- | ------------------------------------------------------- |
| `--window-name <string>` | (required unless `--pid`) | Window title substring (e.g. `mm-1`)                    |
| `--app-name <string>`    | —                         | Restrict title matching to a specific app name          |
| `--max-fps <int>`        | `15`                      | Maximum frame rate                                      |
| `--max-size <int>`       | `720`                     | Max dimension (width or height), preserves aspect ratio |
| `--list-windows`         | —                         | Print available windows as JSON to stderr, then exit    |

## Output Format

- **stdout**: Raw H.264 Annex B byte stream
  - NAL units prefixed with 4-byte start codes (`00 00 00 01`)
  - SPS + PPS prepended to every keyframe
  - Baseline profile, no B-frames
- **stderr**: JSON log lines (`{"type":"info|error","msg":"..."}`)
- **Exit 0** on SIGINT/SIGTERM (clean shutdown)
- **Exit 1** if no matching window or PID-owned window is found

## Permissions

Screen Recording permission must be granted to the terminal app (Terminal.app, iTerm2, etc.) in:

**System Settings → Privacy & Security → Screen Recording**

The first run will trigger a macOS permission dialog. After granting, you may need to restart the terminal app.

## Verification

```bash
# Record a few seconds
./capture-helper --app-name Simulator --window-name Simulator > /tmp/test.h264
# (Ctrl+C after a few seconds)

# Verify stream metadata
ffprobe /tmp/test.h264

# Play back
ffplay -f h264 /tmp/test.h264
```
