import Foundation

/// Everything the app shows for one project, as printed by `ungrind state`.
public struct ProjectState: Codable, Equatable {
    public var project: String
    public var repo: String
    public var configFile: String?
    public var adapter: String
    public var promptVersion: String?
    public var conventionsApproved: Bool
    public var rules: Rules
    public var cards: [Card]
    public var runs: [RunSummary]

    public func cards(in tab: CardTab) -> [Card] {
        cards.filter { $0.tab == tab }.sorted {
            ($0.priority ?? .greatestFiniteMagnitude, $0.id) < ($1.priority ?? .greatestFiniteMagnitude, $1.id)
        }
    }

    public func lastRun(for cardID: String) -> RunSummary? {
        runs.first { $0.taskId == cardID } // runs are newest first
    }
}

public struct Rules: Codable, Equatable {
    public struct Verifier: Codable, Equatable, Hashable {
        public var name: String
        public var command: String
    }
    public struct Agents: Codable, Equatable {
        public var `default`: String
        public var byTier: [String: String]
        public var byType: [String: String]
        public var available: [String]
    }
    public struct Review: Codable, Equatable {
        public var agent: String
        public var blocking: Bool
    }
    public var ladder: [String]
    public var tierBySize: [String: String]
    public var defaultTier: String
    public var failuresPerTier: Int
    public var maxCostUsd: Double
    public var maxAttempts: Int
    public var maxChangedFiles: Int
    public var forbiddenPaths: [String]
    public var branchPattern: String
    public var verifiers: [Verifier]
    public var agents: Agents
    public var humanApprovalTypes: [String]
    public var review: Review?
}

public enum CardTab: String, CaseIterable, Identifiable {
    case active = "Active", shipped = "Shipped", archived = "Archived"
    public var id: String { rawValue }
}

public struct Route: Codable, Equatable, Hashable {
    public var startTier: String
    public var agent: String
    public var model: String?
    public var overridden: Bool
}

public struct Card: Codable, Identifiable, Equatable, Hashable {
    public var id: String
    public var title: String
    public var goal: String
    public var criteria: [String]
    public var files: [String]
    public var status: String // ready | in_progress | done | blocked | unknown:<name>
    public var priority: Double?
    public var dependencies: [String]
    public var size: String?
    public var type: String?
    public var tier: String?
    public var agent: String?
    public var approved: Bool
    public var archived: Bool
    public var draft: Bool
    public var problems: [String]
    public var waiting: Bool
    public var needsApproval: Bool
    public var notes: String
    public var summary: String
    public var file: String?
    public var route: Route

    /// Archived wins; a done card is Shipped; everything else is Active.
    public var tab: CardTab {
        if archived { return .archived }
        return status == "done" ? .shipped : .active
    }

    public var statusLabel: String {
        if draft && status != "done" { return "Draft" }
        switch status {
        case "ready": return waiting ? "Waiting" : "Ready"
        case "in_progress": return "In progress"
        case "done": return "Shipped"
        case "blocked": return "Blocked"
        default: return status.replacingOccurrences(of: "unknown:", with: "")
        }
    }

    /// A card can be shipped when it is ready, passes the contract, and nothing gates it.
    public var canShip: Bool {
        status == "ready" && !archived && !draft && !waiting && problems.isEmpty && !needsApproval
    }

    public var shipBlocker: String? {
        if archived { return "Archived cards don't run." }
        if draft { return "Draft from the first pass. Review it, then mark it ready." }
        if !problems.isEmpty { return "Fix the card first: \(problems.joined(separator: "; "))." }
        if status == "done" { return "Already shipped." }
        if status == "in_progress" { return "A run is already in progress for this card." }
        if status == "blocked" { return "Blocked. Read the notes, fix the card, then set it back to Ready." }
        if waiting { return "Waiting on: \(dependencies.joined(separator: ", "))." }
        if needsApproval { return "This card's type needs your approval first (tick Approved in the editor)." }
        return status == "ready" ? nil : "Status is \(statusLabel)."
    }
}

public struct RunSummary: Codable, Equatable, Identifiable, Hashable {
    public var ts: String
    public var taskId: String
    public var task: String
    public var result: String
    public var reason: String?
    public var branch: String?
    public var dryRun: Bool
    public var pushed: Bool
    public var path: String
    public var agents: String
    public var attempts: Int
    public var costUsd: Double
    public var durationMs: Double
    public var id: String { ts + taskId }
}

/// What the editor sends to `ungrind card-save`.
public struct CardDraft: Codable, Equatable {
    public var id: String?
    public var title = ""
    public var goal = ""
    public var criteria: [String] = []
    public var files: [String] = []
    public var status = "ready"
    public var priority: Double = 1
    public var size: String?
    public var type: String?
    public var tier: String?
    public var agent: String?
    public var dependencies: [String] = []
    public var approved = false
    public var archived = false
    public var draft = false

    public init() {}

    public init(card: Card) {
        id = card.id; title = card.title; goal = card.goal; criteria = card.criteria; files = card.files
        status = card.status.hasPrefix("unknown") ? "ready" : card.status
        priority = card.priority ?? 1; size = card.size; type = card.type; tier = card.tier; agent = card.agent
        dependencies = card.dependencies; approved = card.approved; archived = card.archived; draft = card.draft
    }

    /// The same checks the engine's task contract makes, so the editor can warn before saving.
    public var contractProblems: [String] {
        var out: [String] = []
        if title.trimmingCharacters(in: .whitespaces).isEmpty { out.append("Add a title.") }
        if goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append("Add a goal.") }
        if criteria.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty }) { out.append("Add at least one acceptance criterion.") }
        if files.isEmpty { out.append("Add at least one file or folder in scope.") }
        return out
    }
}

public struct SaveResult: Codable { public var id: String; public var file: String }
public struct InitResult: Codable { public var configFile: String; public var created: Bool }
/// What `ungrind discover` (the first pass) reports back.
public struct DiscoverResult: Codable, Equatable {
    public struct Created: Codable, Equatable { public var id: String; public var title: String; public var state: String }
    public struct Skipped: Codable, Equatable { public var title: String; public var reason: String }
    public var created: [Created]
    public var skipped: [Skipped]
    public var costUsd: Double

    public var summary: String {
        let shipped = created.filter { $0.state == "shipped" }.count
        let drafts = created.count - shipped
        if created.isEmpty { return "The first pass found nothing new to add." }
        var parts: [String] = []
        if shipped > 0 { parts.append("\(shipped) already shipped") }
        if drafts > 0 { parts.append("\(drafts) draft\(drafts == 1 ? "" : "s") to review") }
        var text = "Added \(created.count) card\(created.count == 1 ? "" : "s"): \(parts.joined(separator: ", "))."
        if !skipped.isEmpty { text += " Skipped \(skipped.count)." }
        return text
    }
}
/// The project rules as the editor sees them (`ungrind rules` / `ungrind rules-save`).
public struct RulesDraft: Codable, Equatable {
    public struct Check: Codable, Equatable {
        public var name: String
        public var command: String
        public var timeoutSec: Double
        public init(name: String = "", command: String = "", timeoutSec: Double = 300) { self.name = name; self.command = command; self.timeoutSec = timeoutSec }
    }
    public struct Sizes: Codable, Equatable { public var small: String; public var medium: String; public var large: String }
    public struct Review: Codable, Equatable { public var enabled: Bool; public var agent: String; public var blocking: Bool }

    public var verifiers: [Check]
    public var forbiddenPaths: [String]
    public var branchPattern: String
    public var maxAttempts: Int
    public var maxChangedFiles: Int
    public var push: Bool
    public var ladder: [String]
    public var tierBySize: Sizes
    public var defaultTier: String
    public var failuresPerTier: Int
    public var maxCostUsd: Double
    public var agentDefault: String
    public var localModel: String?
    public var humanApprovalTypes: [String]
    public var review: Review

    /// Turn a tier on or off, keeping the ladder in cheapest-first order and never leaving
    /// a size or the default pointing at a tier that is no longer on the ladder.
    public mutating func setTier(_ tier: String, enabled: Bool, order: [String]) {
        var set = ladder.filter { $0 != tier }
        if enabled { set.append(tier) }
        let rank = { (t: String) in order.firstIndex(of: t) ?? order.count }
        ladder = set.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
        let now = ladder
        guard let fallback = now.first else { return }
        let fix = { (t: String) in now.contains(t) ? t : fallback }
        tierBySize = Sizes(small: fix(tierBySize.small), medium: fix(tierBySize.medium), large: fix(tierBySize.large))
        defaultTier = fix(defaultTier)
    }

    /// Problems the editor can point at before asking the engine (which validates again on save).
    public var problems: [String] {
        var out: [String] = []
        if verifiers.isEmpty { out.append("Add at least one check. Without one, a run has nothing to prove it worked.") }
        if verifiers.contains(where: { $0.name.trimmingCharacters(in: .whitespaces).isEmpty || $0.command.trimmingCharacters(in: .whitespaces).isEmpty }) { out.append("Every check needs a name and a command.") }
        if ladder.isEmpty { out.append("Keep at least one tier on the route.") }
        if ladder.contains("local") && (localModel ?? "").isEmpty { out.append("Choose a local model for the local tier.") }
        if !branchPattern.contains("{slug}") { out.append("The branch name must contain {slug}.") }
        return out
    }
}

public struct RulesPayload: Codable, Equatable {
    public var rules: RulesDraft
    public var defaults: RulesDraft?
    public var installedLocalModels: [String]
    public var knownTiers: [String]
    public var agents: [String]
}
public struct RulesSaveResult: Codable { public var saved: Bool; public var backup: String }

/// One line of the setup check (`ungrind doctor`).
public struct SetupCheck: Codable, Identifiable, Equatable {
    public var id: String
    public var scope: String   // "tools" (this Mac) or "project"
    public var title: String
    public var status: String  // ok | warn | fail | info
    public var detail: String
    public var fix: String?
    public init(id: String, scope: String, title: String, status: String, detail: String, fix: String? = nil) {
        self.id = id; self.scope = scope; self.title = title; self.status = status; self.detail = detail; self.fix = fix
    }
}

public struct SetupReport: Codable, Equatable {
    public struct Conventions: Codable, Equatable {
        public var approved: Bool
        public var path: String
        public var draft: String?
    }
    public var checks: [SetupCheck]
    public var ready: Bool
    public var toolsReady: Bool
    public var conventions: Conventions?

    public func checks(in scope: String) -> [SetupCheck] { checks.filter { $0.scope == scope } }

    /// One line for the header.
    public var headline: String {
        let fails = checks.filter { $0.status == "fail" }.count
        let warns = checks.filter { $0.status == "warn" }.count
        if fails > 0 { return "\(fails) thing\(fails == 1 ? "" : "s") to fix before cards can run." }
        if warns > 0 { return "Ready to run. \(warns) thing\(warns == 1 ? "" : "s") worth a look." }
        return "Everything is ready."
    }
}

public struct FindConfigResult: Codable { public var configFile: String? }
