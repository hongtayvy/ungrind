import Foundation

public struct EngineError: LocalizedError, Equatable {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Where Node and the Ungrind engine live, plus the PATH child processes should see.
public struct EngineEnvironment: Equatable {
    public var nodePath: String
    public var enginePath: String // .../bin/ungrind.js
    public var pathEnv: String

    public init(nodePath: String, enginePath: String, pathEnv: String) {
        self.nodePath = nodePath; self.enginePath = enginePath; self.pathEnv = pathEnv
    }

    /// The engine script: bundled in the app, or pointed at by UNGRIND_ENGINE, or the repo this source lives in (dev builds).
    public static func locateEngine(bundle: Bundle = .main, env: [String: String] = ProcessInfo.processInfo.environment, sourceFile: String = #filePath) -> String? {
        let fm = FileManager.default
        var candidates: [String] = []
        if let e = env["UNGRIND_ENGINE"] { candidates.append(e) }
        if let r = bundle.resourceURL { candidates.append(r.appendingPathComponent("engine/bin/ungrind.js").path) }
        // mac/Sources/UngrindKit/Engine.swift -> repo root
        let root = URL(fileURLWithPath: sourceFile).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        candidates.append(root.appendingPathComponent("bin/ungrind.js").path)
        return candidates.first { fm.fileExists(atPath: $0) }
    }

    /// GUI apps start with a bare PATH, so ask the user's login shell where node is and what PATH it uses.
    public static func shellEnvironment(shell: String = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh") -> (node: String?, path: String) {
        let fallbackPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-ilc", "printf '__UG_NODE__%s__UG_PATH__%s__UG_END__' \"$(command -v node)\" \"$PATH\""]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return (findNode(in: fallbackPath), fallbackPath) }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        guard let parsed = parseShellProbe(text) else { return (findNode(in: fallbackPath), fallbackPath) }
        let node = parsed.node.isEmpty ? findNode(in: parsed.path) : parsed.node
        return (node, parsed.path)
    }

    public static func parseShellProbe(_ text: String) -> (node: String, path: String)? {
        guard let a = text.range(of: "__UG_NODE__"), let b = text.range(of: "__UG_PATH__"), let c = text.range(of: "__UG_END__"),
              a.upperBound <= b.lowerBound, b.upperBound <= c.lowerBound else { return nil }
        return (String(text[a.upperBound..<b.lowerBound]), String(text[b.upperBound..<c.lowerBound]))
    }

    static func findNode(in path: String) -> String? {
        path.split(separator: ":").map { "\($0)/node" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    public static func discover() throws -> EngineEnvironment {
        guard let engine = locateEngine() else { throw EngineError("The Ungrind engine wasn't found in the app bundle. Set UNGRIND_ENGINE to bin/ungrind.js.") }
        let shell = shellEnvironment()
        guard let node = shell.node else { throw EngineError("Node.js wasn't found. Install Node 20 or later (nodejs.org or `brew install node`), then reopen Ungrind.") }
        return EngineEnvironment(nodePath: node, enginePath: engine, pathEnv: shell.path)
    }
}

/// Runs engine commands. One-shot commands return decoded JSON; `stream` feeds a run's log line by line.
public final class EngineClient: @unchecked Sendable {
    public let env: EngineEnvironment
    public init(env: EngineEnvironment) { self.env = env }

    private func makeProcess(_ args: [String], cwd: String?) -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: env.nodePath)
        p.arguments = [env.enginePath] + args
        var e = ProcessInfo.processInfo.environment
        e["PATH"] = env.pathEnv
        p.environment = e
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        return p
    }

    /// Run a command to completion. Throws EngineError with the engine's own message on a non-zero exit.
    public func output(_ args: [String], stdin: Data? = nil, cwd: String? = nil) async throws -> Data {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                let p = makeProcess(args, cwd: cwd)
                let out = Pipe(), err = Pipe(), inp = Pipe()
                p.standardOutput = out; p.standardError = err; p.standardInput = inp
                do { try p.run() } catch { cont.resume(throwing: EngineError("Couldn't start Node: \(error.localizedDescription)")); return }
                if let stdin { inp.fileHandleForWriting.write(stdin) }
                try? inp.fileHandleForWriting.close()
                // Read stderr on another queue so a full pipe can't deadlock the child.
                var errData = Data()
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.global().async { errData = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
                let data = out.fileHandleForReading.readDataToEndOfFile()
                group.wait()
                p.waitUntilExit()
                if p.terminationStatus != 0 {
                    let msg = String(decoding: errData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                    cont.resume(throwing: EngineError(msg.replacingOccurrences(of: "ungrind: ", with: "").isEmpty ? "The engine exited with code \(p.terminationStatus)." : msg.replacingOccurrences(of: "ungrind: ", with: "")))
                } else {
                    cont.resume(returning: data)
                }
            }
        }
    }

    public func json<T: Decodable>(_ type: T.Type, _ args: [String], stdin: Data? = nil) async throws -> T {
        let data = try await output(args, stdin: stdin)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw EngineError("The engine returned something unexpected: \(error.localizedDescription)") }
    }

    public func findConfig(dir: String) async throws -> String? {
        try await json(FindConfigResult.self, ["find-config", "--dir", dir]).configFile
    }

    public func initProject(dir: String) async throws -> InitResult {
        try await json(InitResult.self, ["init", "--dir", dir])
    }

    public func state(config: String) async throws -> ProjectState {
        try await json(ProjectState.self, ["state", "--config", config])
    }

    public func save(_ draft: CardDraft, config: String) async throws -> SaveResult {
        try await json(SaveResult.self, ["card-save", "--config", config], stdin: JSONEncoder().encode(draft))
    }

    /// Start a long-running command (a run). Lines from stdout and stderr arrive on `onLine`; returns the exit code.
    /// The returned handle can stop the run.
    public func stream(_ args: [String], cwd: String? = nil, onLine: @escaping @Sendable (String) -> Void, onExit: @escaping @Sendable (Int32) -> Void) -> RunHandle {
        let p = makeProcess(args, cwd: cwd)
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = pipe; p.standardInput = FileHandle.nullDevice
        let buffer = LineBuffer(onLine: onLine)
        pipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if !d.isEmpty { buffer.append(d) }
        }
        p.terminationHandler = { proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            buffer.append(pipe.fileHandleForReading.readDataToEndOfFile())
            buffer.flush()
            onExit(proc.terminationStatus)
        }
        do { try p.run() } catch {
            onLine("Couldn't start Node: \(error.localizedDescription)")
            onExit(127)
        }
        return RunHandle(process: p)
    }
}

public final class RunHandle: @unchecked Sendable {
    let process: Process
    init(process: Process) { self.process = process }
    /// Ask the engine to stop. Its `finally` block returns the repo to the base branch.
    public func stop() { if process.isRunning { process.interrupt() } }
}

/// Splits a byte stream into lines; safe to call from the pipe's callback queue.
final class LineBuffer: @unchecked Sendable {
    private var data = Data()
    private let lock = NSLock()
    private let onLine: @Sendable (String) -> Void
    init(onLine: @escaping @Sendable (String) -> Void) { self.onLine = onLine }

    func append(_ chunk: Data) {
        lock.lock(); defer { lock.unlock() }
        data.append(chunk)
        while let i = data.firstIndex(of: 0x0A) {
            onLine(String(decoding: data[data.startIndex..<i], as: UTF8.self))
            data.removeSubrange(data.startIndex...i)
        }
    }

    func flush() {
        lock.lock(); defer { lock.unlock() }
        if !data.isEmpty { onLine(String(decoding: data, as: UTF8.self)); data.removeAll() }
    }
}
