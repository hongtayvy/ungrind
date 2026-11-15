import AppKit
import Observation
import UngrindKit

struct ProjectRef: Identifiable, Hashable {
    var path: String
    var id: String { path }
    var name: String { URL(fileURLWithPath: path).lastPathComponent }
}

enum ProjectLoad: Equatable {
    case loading
    case needsSetup
    case ready(ProjectState, config: String)
    case failed(String)
}

/// One engine run started from the app. Lines stream in while it runs.
struct RunSession: Equatable {
    var projectPath: String
    var cardID: String
    var cardTitle: String
    var dryRun: Bool
    var lines: [String] = []
    var exitCode: Int32?
    var isRunning: Bool { exitCode == nil }
    var outcome: String {
        guard let exitCode else { return dryRun ? "Dry run in progress" : "Shipping" }
        let last = lines.last { $0.contains("[ungrind] result:") }?.replacingOccurrences(of: "[ungrind] result: ", with: "")
        return last ?? (exitCode == 0 ? "Finished" : "Failed (exit \(exitCode))")
    }
}

@MainActor
@Observable
final class AppModel {
    var projects: [ProjectRef] = []
    var selectedPath: String? { didSet { if oldValue != selectedPath { selectedCardID = nil; reloadSelected() } } }
    var loads: [String: ProjectLoad] = [:]
    var selectedCardID: String?
    var tab: CardTab = .active
    var editing: CardDraft?
    var run: RunSession?
    var alert: String?
    var engineProblem: String?
    var confirmShipWithoutConventions: Card?
    var notice: String?
    /// Folder paths with a first pass in flight.
    var discovering: Set<String> = []

    private var client: EngineClient?
    private var handle: RunHandle?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        projects = (defaults.stringArray(forKey: "projects") ?? []).map(ProjectRef.init(path:))
        Task { await start() }
    }

    private func start() async {
        do {
            let env = try await Task.detached { try EngineEnvironment.discover() }.value
            client = EngineClient(env: env)
            selectedPath = defaults.string(forKey: "selectedProject").flatMap { p in projects.contains { $0.path == p } ? p : nil } ?? projects.first?.path
            reloadSelected()
        } catch {
            engineProblem = error.localizedDescription
        }
    }

    // MARK: Derived state

    var selectedState: ProjectState? {
        if case .ready(let s, _)? = selectedPath.flatMap({ loads[$0] }) { return s }
        return nil
    }
    private var selectedConfig: String? {
        if case .ready(_, let c)? = selectedPath.flatMap({ loads[$0] }) { return c }
        return nil
    }
    var selectedCard: Card? { selectedState?.cards.first { $0.id == selectedCardID } }
    var isRunning: Bool { run?.isRunning ?? false }

    // MARK: Projects

    func addFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Add Folder"
        panel.message = "Choose a project folder for Ungrind"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let path = url.path
        if !projects.contains(where: { $0.path == path }) {
            projects.append(ProjectRef(path: path))
            persist()
        }
        selectedPath = path
    }

    func remove(_ project: ProjectRef) {
        projects.removeAll { $0 == project }
        loads[project.path] = nil
        if selectedPath == project.path { selectedPath = projects.first?.path }
        persist()
    }

    private func persist() {
        defaults.set(projects.map(\.path), forKey: "projects")
        defaults.set(selectedPath, forKey: "selectedProject")
    }

    func reloadSelected() {
        guard let path = selectedPath else { return }
        defaults.set(path, forKey: "selectedProject")
        Task { await reload(path) }
    }

    func reload(_ path: String) async {
        guard let client else { return }
        if loads[path] == nil { loads[path] = .loading }
        do {
            guard let config = try await client.findConfig(dir: path) else { loads[path] = .needsSetup; return }
            loads[path] = .ready(try await client.state(config: config), config: config)
        } catch {
            loads[path] = .failed(error.localizedDescription)
        }
    }

    /// Writes ungrind.config.yaml and a tasks folder into the project. Only runs when the user asks.
    func setUpSelected() {
        guard let path = selectedPath, let client else { return }
        Task {
            do { _ = try await client.initProject(dir: path); await reload(path) }
            catch { alert = error.localizedDescription }
        }
    }

    // MARK: First pass

    var isDiscovering: Bool { selectedPath.map(discovering.contains) ?? false }

    /// Reads the folder with the strongest model and drafts feature cards. Drafts don't run until marked ready.
    func runFirstPass() {
        guard let path = selectedPath, let config = selectedConfig, let client, !discovering.contains(path) else { return }
        discovering.insert(path)
        Task {
            defer { discovering.remove(path) }
            do {
                let result = try await client.discover(config: config)
                await reload(path)
                if selectedPath == path { tab = .active }
                notice = result.summary + String(format: " Cost: $%.2f.", result.costUsd)
            } catch {
                alert = error.localizedDescription
            }
        }
    }

    // MARK: Cards

    func newCard() {
        var d = CardDraft()
        d.priority = Double((selectedState?.cards.compactMap(\.priority).max() ?? 0) + 1)
        editing = d
    }

    func save(_ draft: CardDraft) async -> Bool {
        guard let path = selectedPath, let config = selectedConfig, let client else { return false }
        do {
            let saved = try await client.save(draft, config: config)
            await reload(path)
            selectedCardID = saved.id
            if let c = selectedCard { tab = c.tab }
            return true
        } catch {
            alert = error.localizedDescription
            return false
        }
    }

    /// Quick edits from the detail column (route override, archive, back to ready).
    func update(_ card: Card, _ change: (inout CardDraft) -> Void) {
        var d = CardDraft(card: card)
        change(&d)
        Task { _ = await save(d) }
    }

    // MARK: Shipping

    func ship(_ card: Card, dryRun: Bool, allowWithoutConventions: Bool = false) {
        guard let path = selectedPath, let config = selectedConfig, let state = selectedState, let client, !isRunning else { return }
        if !dryRun && !state.conventionsApproved && !allowWithoutConventions {
            confirmShipWithoutConventions = card
            return
        }
        var args = ["run", "--config", config, "--task", card.id]
        if dryRun { args.append("--dry-run") }
        if !state.conventionsApproved { args.append("--skip-conventions") }
        run = RunSession(projectPath: path, cardID: card.id, cardTitle: card.title, dryRun: dryRun)
        handle = client.stream(args, cwd: path, onLine: { line in
            Task { @MainActor in self.run?.lines.append(line) }
        }, onExit: { code in
            Task { @MainActor in
                self.run?.exitCode = code
                self.handle = nil
                await self.reload(path)
            }
        })
    }

    func stopRun() { handle?.stop() }

    // MARK: Opening things in the user's own tools

    func open(_ path: String?) {
        guard let path else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    func reveal(_ path: String?) {
        guard let path else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }
}
