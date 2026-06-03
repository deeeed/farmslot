// capture-helper.swift — ScreenCaptureKit → H.264 Annex B stdout
// macOS 13.0+ · Single-file Swift CLI · No dependencies
//
// Binary contract: Annex B NAL units with 4-byte start codes (00 00 00 01).
// Keyframes are prefixed with SPS (type 7) + PPS (type 8).
// Baseline profile, no B-frames (decode order = display order).
//
// Multi-window: one process captures N windows dynamically via stdin commands.
// Windows can be added/removed without restarting — existing streams are unaffected.
// Framed header: [4B len][1B flags][1B windowIndex][payload] (6 bytes).
//
// Stdin commands (line-based, requires --framed):
//   +name <substring>    Add window by title substring
//   +match <app>\t<title> Add window by app name + title substring
//   +pid <int>           Add largest window owned by PID
//   -<index>             Remove window at index
//
// Stderr JSON events:
//   {"type":"added","index":N,"name":"...","width":W,"height":H}
//   {"type":"add_failed","name":"...","error":"..."}
//   {"type":"removed","index":N}
//   {"type":"info","msg":"..."}
//   {"type":"error","msg":"..."}

import Foundation
import AppKit
import ScreenCaptureKit
import CoreMedia
import VideoToolbox
import CoreGraphics

// Force CoreGraphics Server initialization (required for CLI tools using SCStream/VTCompressionSession)
_ = CGMainDisplayID()

// MARK: - CLI

struct Config {
    var initialNames: [String] = []
    var initialAppName: String? = nil
    var initialPid: pid_t? = nil
    var maxFps: Int32 = 15
    var maxSize: Int = 720
    var listWindows = false
    var framed = false
}

func parseArgs() -> Config {
    var cfg = Config()
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        switch args[i] {
        case "--window-name":
            i += 1; guard i < args.count else { exitUsage() }
            cfg.initialNames.append(args[i])
        case "--window-names":
            i += 1; guard i < args.count else { exitUsage() }
            cfg.initialNames += args[i].split(separator: ",").map(String.init)
        case "--app-name":
            i += 1; guard i < args.count else { exitUsage() }
            cfg.initialAppName = args[i]
        case "--pid":
            i += 1; guard i < args.count, let v = Int32(args[i]) else { exitUsage() }
            cfg.initialPid = v
        case "--max-fps":
            i += 1; guard i < args.count, let v = Int32(args[i]) else { exitUsage() }
            cfg.maxFps = v
        case "--max-size":
            i += 1; guard i < args.count, let v = Int(args[i]) else { exitUsage() }
            cfg.maxSize = v
        case "--framed":
            cfg.framed = true
        case "--list-windows":
            cfg.listWindows = true
        case "--help", "-h":
            exitUsage()
        default:
            log("error", "unknown argument: \(args[i])"); exitUsage()
        }
        i += 1
    }
    return cfg
}

func exitUsage() -> Never {
    let usage = """
    capture-helper — macOS window screen → H.264 Annex B (stdout)

    Usage: capture-helper [options]
      --window-name <string>   Window title substring. Can repeat.
      --window-names <a,b,...>  Comma-separated window title substrings.
      --app-name <string>      Restrict title matching to a specific app name.
      --pid <int>              Capture largest window owned by PID.
      --max-fps <int>          Max frame rate (default: 15)
      --max-size <int>         Max dimension in pixels (default: 720)
      --framed                 Framed output (6-byte header) + stdin commands
      --list-windows           Print available windows as JSON to stderr, exit
      --help                   Show this message

    Stdin commands (requires --framed):
      +name <substring>        Add window by title substring
      +match <app>\t<title>    Add window by app name + title substring
      +pid <int>               Add largest window owned by PID
      -<index>                 Remove window at index
    """
    FileHandle.standardError.write(Data(usage.utf8))
    exit(0)
}

// MARK: - Logging

func log(_ type: String, _ msg: String) {
    let escaped = msg.replacingOccurrences(of: "\\", with: "\\\\")
                     .replacingOccurrences(of: "\"", with: "\\\"")
    let json = "{\"type\":\"\(type)\",\"msg\":\"\(escaped)\"}\n"
    FileHandle.standardError.write(Data(json.utf8))
}

func logEvent(_ pairs: (String, Any)...) {
    var parts: [String] = []
    for (key, val) in pairs {
        if let s = val as? String {
            let escaped = s.replacingOccurrences(of: "\\", with: "\\\\")
                           .replacingOccurrences(of: "\"", with: "\\\"")
            parts.append("\"\(key)\":\"\(escaped)\"")
        } else {
            parts.append("\"\(key)\":\(val)")
        }
    }
    let json = "{\(parts.joined(separator: ","))}\n"
    FileHandle.standardError.write(Data(json.utf8))
}

// MARK: - Window Discovery

enum CaptureError: Error, CustomStringConvertible {
    case windowNotFound(String)
    case setupFailed(String)

    var description: String {
        switch self {
        case .windowNotFound(let msg): return msg
        case .setupFailed(let msg): return msg
        }
    }
}

func loadWindows(onScreenOnly: Bool) async throws -> [SCWindow] {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: onScreenOnly)
    return content.windows.filter { w in w.frame.width > 0 && w.frame.height > 0 }
}

func listAllWindows() async throws -> Never {
    let onScreenWindows = try await loadWindows(onScreenOnly: true)
    let onScreenIds = Set(onScreenWindows.map(\.windowID))
    let allWindows = try await loadWindows(onScreenOnly: false)
    for w in allWindows {
        let title = (w.title ?? "").replacingOccurrences(of: "\"", with: "\\\"")
        let appName = (w.owningApplication?.applicationName ?? "").replacingOccurrences(of: "\"", with: "\\\"")
        let appPid = w.owningApplication?.processID ?? 0
        let info = "{\"id\":\(w.windowID),\"title\":\"\(title)\",\"app\":\"\(appName)\",\"pid\":\(appPid),\"size\":\"\(Int(w.frame.width))x\(Int(w.frame.height))\",\"onScreen\":\(onScreenIds.contains(w.windowID) ? "true" : "false")}"
        FileHandle.standardError.write(Data((info + "\n").utf8))
    }
    exit(0)
}

func filteredWindows(_ windows: [SCWindow], appName: String?, titleSubstring: String) -> [SCWindow] {
    windows.filter { w in
        guard let title = w.title, title.contains(titleSubstring) else { return false }
        if let appName {
            return w.owningApplication?.applicationName == appName
        }
        return true
    }.sorted { a, b in
        (a.frame.width * a.frame.height) > (b.frame.width * b.frame.height)
    }
}

func availableTitles(_ windows: [SCWindow], appName: String?) -> String {
    let scoped = windows.filter { w in
        guard let title = w.title, !title.isEmpty else { return false }
        if let appName {
            return w.owningApplication?.applicationName == appName
        }
        return true
    }
    let names = scoped.map { "\($0.title!)" }
    return names.isEmpty ? "" : names.joined(separator: ", ")
}

func findWindowByName(_ name: String, appName: String? = nil) async throws -> SCWindow {
    let onScreenWindows = try await loadWindows(onScreenOnly: true)
    let onScreenMatches = filteredWindows(onScreenWindows, appName: appName, titleSubstring: name)
    if let window = onScreenMatches.first { return window }

    let allWindows = try await loadWindows(onScreenOnly: false)
    let fallbackMatches = filteredWindows(allWindows, appName: appName, titleSubstring: name)
    if let window = fallbackMatches.first {
        log("info", "falling back to off-screen window lookup for \(appName ?? "any-app")/\(name)")
        return window
    }

    let appLabel = appName ?? "any app"
    let visible = availableTitles(onScreenWindows, appName: appName)
    let all = availableTitles(allWindows, appName: appName)
    throw CaptureError.windowNotFound(
        "no window matching '\(name)' in \(appLabel) (visible: \(visible); all: \(all))"
    )
}

func findWindowByPid(_ pid: pid_t) async throws -> SCWindow {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    let windows = content.windows.filter { w in
        guard w.owningApplication?.processID == pid else { return false }
        guard w.frame.width > 100 && w.frame.height > 100 else { return false }
        guard w.windowLayer == 0 else { return false }
        // Exclude ultrawide toolbars (e.g. 3840x30)
        let ratio = w.frame.width / max(w.frame.height, 1)
        return ratio < 10
    }
    let sorted = windows.sorted { a, b in
        (a.frame.width * a.frame.height) > (b.frame.width * b.frame.height)
    }
    guard let window = sorted.first else {
        throw CaptureError.windowNotFound("no window found for PID \(pid)")
    }
    return window
}

// MARK: - Annex B Conversion

let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]

func extractParameterSets(from format: CMFormatDescription) -> Data {
    var result = Data()
    var paramCount: Int = 0
    if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &paramCount, nalUnitHeaderLengthOut: nil) == noErr {
        for i in 0..<paramCount {
            var ptr: UnsafePointer<UInt8>?
            var size: Int = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &ptr, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let ptr = ptr {
                result.append(contentsOf: startCode)
                result.append(ptr, count: size)
            }
        }
    }
    return result
}

func lengthPrefixedToAnnexB(_ data: Data) -> Data {
    var result = Data()
    var offset = 0
    while offset + 4 <= data.count {
        let len = Int(data[offset]) << 24 | Int(data[offset+1]) << 16 |
                  Int(data[offset+2]) << 8 | Int(data[offset+3])
        offset += 4
        guard len > 0, offset + len <= data.count else { break }
        result.append(contentsOf: startCode)
        result.append(data[offset..<offset+len])
        offset += len
    }
    return result
}

// MARK: - Stdout Writer

let writeQueue = DispatchQueue(label: "stdout-writer")

func writeStdout(_ data: Data) {
    writeQueue.sync {
        data.withUnsafeBytes { buf in
            guard let ptr = buf.baseAddress else { return }
            var written = 0
            while written < data.count {
                let n = Darwin.write(STDOUT_FILENO, ptr + written, data.count - written)
                if n <= 0 { break }
                written += n
            }
        }
    }
}

// MARK: - Window Slot

class WindowSlot {
    let index: UInt8
    let name: String
    let session: VTCompressionSession
    let stream: SCStream
    let delegate: CaptureDelegate
    let errorDelegate: WindowErrorDelegate
    let outWidth: Int
    let outHeight: Int

    init(index: UInt8, name: String, session: VTCompressionSession, stream: SCStream,
         delegate: CaptureDelegate, errorDelegate: WindowErrorDelegate,
         outWidth: Int, outHeight: Int) {
        self.index = index
        self.name = name
        self.session = session
        self.stream = stream
        self.delegate = delegate
        self.errorDelegate = errorDelegate
        self.outWidth = outWidth
        self.outHeight = outHeight
    }

    func stop() {
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
        stream.stopCapture { _ in }
    }
}

// Slots array — indices are stable (removed slots become nil, reused on next add).
// Thread safety: commands are serialized by the stdin reader semaphore.
// WindowErrorDelegate runs on SCStream's queue but only nils out its own slot — benign.
var slots: [WindowSlot?] = []

func allocateIndex() -> UInt8 {
    if let freeIdx = slots.firstIndex(where: { $0 == nil }) {
        return UInt8(freeIdx)
    }
    let idx = slots.count
    slots.append(nil)
    return UInt8(idx)
}

var activeWindowCount: Int {
    slots.compactMap { $0 }.count
}

func addWindowCapture(name: String, window: SCWindow) async throws -> WindowSlot {
    let index = allocateIndex()

    let srcW = Int(window.frame.width)
    let srcH = Int(window.frame.height)
    let scale = min(Double(cfg.maxSize) / Double(max(srcW, srcH)), 1.0)
    let outW = Int(Double(srcW) * scale) & ~1
    let outH = Int(Double(srcH) * scale) & ~1

    var session: VTCompressionSession?
    let status = VTCompressionSessionCreate(
        allocator: nil,
        width: Int32(outW), height: Int32(outH),
        codecType: kCMVideoCodecType_H264,
        encoderSpecification: nil,
        imageBufferAttributes: nil,
        compressedDataAllocator: nil,
        outputCallback: nil,
        refcon: nil,
        compressionSessionOut: &session
    )
    guard status == noErr, let session = session else {
        throw CaptureError.setupFailed("VTCompressionSessionCreate failed: \(status)")
    }

    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: 500_000 as CFNumber)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (cfg.maxFps * 2) as CFNumber)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTCompressionSessionPrepareToEncodeFrames(session)

    let filter = SCContentFilter(desktopIndependentWindow: window)
    let streamCfg = SCStreamConfiguration()
    streamCfg.minimumFrameInterval = .zero
    streamCfg.width = outW
    streamCfg.height = outH
    streamCfg.pixelFormat = kCVPixelFormatType_32BGRA
    streamCfg.showsCursor = false
    streamCfg.queueDepth = 3

    let errDelegate = WindowErrorDelegate(windowIndex: index)
    let stream = SCStream(filter: filter, configuration: streamCfg, delegate: errDelegate)

    let delegate = CaptureDelegate(session: session, maxFps: cfg.maxFps, windowIndex: index)
    try stream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture-\(index)"))

    try await stream.startCapture()

    let slot = WindowSlot(
        index: index, name: name, session: session, stream: stream,
        delegate: delegate, errorDelegate: errDelegate,
        outWidth: outW, outHeight: outH
    )
    slots[Int(index)] = slot
    return slot
}

func removeWindowCapture(index: Int) {
    guard index < slots.count, let slot = slots[index] else { return }
    slot.stop()
    slots[index] = nil
}

func removeAllWindows() {
    for i in 0..<slots.count {
        if let slot = slots[i] {
            slot.stop()
            slots[i] = nil
        }
    }
}

// MARK: - Capture Delegate

class WindowErrorDelegate: NSObject, SCStreamDelegate {
    let windowIndex: UInt8

    init(windowIndex: UInt8) {
        self.windowIndex = windowIndex
        super.init()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("error", "window[\(windowIndex)] stream stopped: \(error)")
        removeWindowCapture(index: Int(windowIndex))
        logEvent(("type", "removed"), ("index", Int(windowIndex)))
    }
}

class CaptureDelegate: NSObject, SCStreamOutput {
    let session: VTCompressionSession
    let maxFps: Int32
    let windowIndex: UInt8
    private var frameCount: Int64 = 0
    private let keyFrameInterval: Int64
    private let minEncodeInterval: CMTime
    private var lastEncodedPts: CMTime = .invalid

    init(session: VTCompressionSession, maxFps: Int32, windowIndex: UInt8) {
        self.session = session
        self.maxFps = maxFps
        self.windowIndex = windowIndex
        self.keyFrameInterval = Int64(maxFps) * 2
        self.minEncodeInterval = CMTime(value: 1, timescale: maxFps)
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if lastEncodedPts.isValid {
            let delta = CMTimeSubtract(pts, lastEncodedPts)
            if delta.isNumeric && CMTimeCompare(delta, minEncodeInterval) < 0 {
                return
            }
        }
        let dur = CMTime(value: 1, timescale: maxFps)

        var properties: CFDictionary? = nil
        if frameCount % keyFrameInterval == 0 {
            properties = [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
        }

        VTCompressionSessionEncodeFrame(session, imageBuffer: pixelBuffer,
                                        presentationTimeStamp: pts, duration: dur,
                                        frameProperties: properties,
                                        infoFlagsOut: nil, outputHandler: { [self] status, _, sbuf in
            guard status == noErr, let sbuf = sbuf else { return }
            self.handleEncodedFrame(sbuf)
        })
        lastEncodedPts = pts
        frameCount += 1
        if frameCount == 1 || frameCount % 300 == 0 {
            log("info", "window=\(windowIndex) frames=\(frameCount)")
        }
    }

    private func handleEncodedFrame(_ sampleBuffer: CMSampleBuffer) {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]],
              let first = attachments.first else { return }

        let isKeyframe = !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)

        var output = Data()

        if isKeyframe, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
            output.append(extractParameterSets(from: format))
        }

        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var totalLength: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: nil,
                                          totalLengthOut: &totalLength, dataPointerOut: &dataPointer) == noErr,
              let ptr = dataPointer else { return }

        let frameData = Data(bytes: ptr, count: totalLength)
        output.append(lengthPrefixedToAnnexB(frameData))

        if cfg.framed {
            // [4B payload len BE][1B flags (bit 0 = keyframe)][1B windowIndex]
            var header = Data(count: 6)
            let len = UInt32(output.count)
            header[0] = UInt8((len >> 24) & 0xFF)
            header[1] = UInt8((len >> 16) & 0xFF)
            header[2] = UInt8((len >> 8) & 0xFF)
            header[3] = UInt8(len & 0xFF)
            header[4] = isKeyframe ? 1 : 0
            header[5] = windowIndex
            writeStdout(header + output)
        } else {
            writeStdout(output)
        }
    }
}

// MARK: - Stdin Command Reader

func startStdinReader() {
    Thread.detachNewThread {
        while let line = readLine() {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }

            // Serialize: wait for command to finish before reading next line
            let semaphore = DispatchSemaphore(value: 0)
            Task {
                await handleCommand(trimmed)
                semaphore.signal()
            }
            semaphore.wait()
        }
        // EOF on stdin — agent process died, clean up
        log("info", "stdin closed, shutting down")
        removeAllWindows()
        exit(0)
    }
}

func handleCommand(_ cmd: String) async {
    if cmd.hasPrefix("+name ") {
        let name = String(cmd.dropFirst(6))
        do {
            let window = try await findWindowByName(name)
            let slot = try await addWindowCapture(name: name, window: window)
            logEvent(("type", "added"), ("index", Int(slot.index)),
                     ("name", name), ("width", slot.outWidth), ("height", slot.outHeight))
        } catch {
            logEvent(("type", "add_failed"), ("name", name), ("error", "\(error)"))
        }
    } else if cmd.hasPrefix("+match ") {
        let payload = String(cmd.dropFirst(7))
        let parts = payload.split(separator: "\t", maxSplits: 1).map(String.init)
        guard parts.count == 2 else {
            logEvent(("type", "add_failed"), ("name", payload), ("error", "expected +match <app>\\t<title>"))
            return
        }
        let appName = parts[0]
        let title = parts[1]
        do {
            let window = try await findWindowByName(title, appName: appName)
            let slot = try await addWindowCapture(name: title, window: window)
            logEvent(("type", "added"), ("index", Int(slot.index)),
                     ("name", "\(appName):\(title)"), ("width", slot.outWidth), ("height", slot.outHeight))
        } catch {
            logEvent(("type", "add_failed"), ("name", "\(appName):\(title)"), ("error", "\(error)"))
        }
    } else if cmd.hasPrefix("+pid ") {
        let pidStr = String(cmd.dropFirst(5))
        guard let pid = Int32(pidStr) else {
            logEvent(("type", "add_failed"), ("name", "pid:\(pidStr)"), ("error", "invalid PID"))
            return
        }
        do {
            let window = try await findWindowByPid(pid)
            let name = window.title ?? "pid:\(pid)"
            let slot = try await addWindowCapture(name: name, window: window)
            logEvent(("type", "added"), ("index", Int(slot.index)),
                     ("name", name), ("width", slot.outWidth), ("height", slot.outHeight))
        } catch {
            logEvent(("type", "add_failed"), ("name", "pid:\(pid)"), ("error", "\(error)"))
        }
    } else if cmd.hasPrefix("-") {
        let idxStr = String(cmd.dropFirst(1))
        guard let idx = Int(idxStr) else {
            log("error", "invalid index: \(idxStr)")
            return
        }
        guard idx < slots.count, slots[idx] != nil else {
            log("error", "no window at index \(idx)")
            return
        }
        removeWindowCapture(index: idx)
        logEvent(("type", "removed"), ("index", idx))
    } else {
        log("error", "unknown command: \(cmd)")
    }
}

// MARK: - Main

let cfg = parseArgs()

setbuf(stdout, nil)

// Signal handling
let sigintSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let sigtermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

func cleanup() {
    log("info", "shutting down")
    removeAllWindows()
    exit(0)
}

sigintSrc.setEventHandler { cleanup() }
sigtermSrc.setEventHandler { cleanup() }
sigintSrc.resume()
sigtermSrc.resume()

Task {
    do {
        if cfg.listWindows {
            try await listAllWindows()
        }

        // Add initial windows from CLI args
        for name in cfg.initialNames {
            let window = try await findWindowByName(name, appName: cfg.initialAppName)
            let slot = try await addWindowCapture(name: name, window: window)
            logEvent(("type", "added"), ("index", Int(slot.index)),
                     ("name", name), ("width", slot.outWidth), ("height", slot.outHeight))
        }

        if let pid = cfg.initialPid {
            let window = try await findWindowByPid(pid)
            let name = window.title ?? "pid:\(pid)"
            let slot = try await addWindowCapture(name: name, window: window)
            logEvent(("type", "added"), ("index", Int(slot.index)),
                     ("name", name), ("width", slot.outWidth), ("height", slot.outHeight))
        }

        // In framed mode, accept dynamic stdin commands
        if cfg.framed {
            startStdinReader()
        }

        // In non-framed legacy mode, require at least one window
        if !cfg.framed && activeWindowCount == 0 {
            log("error", "--window-name or --pid is required in non-framed mode")
            exit(1)
        }

    } catch {
        log("error", "\(error)")
        exit(1)
    }
}

dispatchMain()
