import SwiftUI
import UngrindKit

// MARK: - Right: the selected card's route, rules, and last run

struct DetailColumn: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let state = model.selectedState, let card = model.selectedCard {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        CardHeader(card: card)
                        if !card.problems.isEmpty { ProblemsBox(problems: card.problems) }
                        CardBody(card: card)
                        RouteSection(card: card, rules: state.rules)
                        RulesSection(state: state)
                        LastRunSection(card: card, run: state.lastRun(for: card.id))
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                Divider()
                ShipBar(card: card)
            }
        } else {
            ContentUnavailableView("Select a card", systemImage: "rectangle.and.text.magnifyingglass", description: Text("Its route, rules, and last run show up here."))
        }
    }
}

struct CardHeader: View {
    @Environment(AppModel.self) private var model
    let card: Card

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                Text(card.title.isEmpty ? card.id : card.title).font(.title2.weight(.semibold)).textSelection(.enabled)
                HStack(spacing: 8) {
                    StatusPill(card: card)
                    Text(card.id).font(.caption.monospaced()).foregroundStyle(.secondary)
                    if let size = card.size { Text(size).font(.caption).foregroundStyle(.secondary) }
                    if let type = card.type { Text(type).font(.caption).foregroundStyle(.secondary) }
                }
            }
            Spacer()
            Button("Edit") { model.editing = CardDraft(card: card) }
            Menu {
                if card.status == "blocked" || card.status == "done" {
                    Button("Set Back to Ready") { model.update(card) { $0.status = "ready" } }
                }
                Button(card.archived ? "Unarchive" : "Archive") { model.update(card) { $0.archived.toggle() } }
                Divider()
                Button("Open Card File") { model.open(card.file) }
                Button("Show Card in Finder") { model.reveal(card.file) }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
    }
}

struct ProblemsBox: View {
    let problems: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("This card can't run yet", systemImage: "exclamationmark.triangle.fill").font(.headline).foregroundStyle(.orange)
            ForEach(problems, id: \.self) { Text("• \($0)") }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct DetailSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
            content
        }
    }
}

struct CardBody: View {
    let card: Card
    var body: some View {
        DetailSection(title: "Goal") {
            Text(card.goal.isEmpty ? "No goal yet." : card.goal).foregroundStyle(card.goal.isEmpty ? .secondary : .primary).textSelection(.enabled)
        }
        DetailSection(title: "Acceptance criteria") {
            if card.criteria.isEmpty { Text("None yet.").foregroundStyle(.secondary) }
            ForEach(card.criteria, id: \.self) { c in
                Label(c, systemImage: card.status == "done" ? "checkmark.circle.fill" : "circle").textSelection(.enabled)
            }
        }
        DetailSection(title: "Scope") {
            if card.files.isEmpty { Text("No files in scope. The card needs at least one path.").foregroundStyle(.secondary) }
            else {
                Text(card.files.joined(separator: "\n")).font(.callout.monospaced()).textSelection(.enabled)
                Text("Changes outside these paths fail the run.").font(.caption).foregroundStyle(.secondary)
            }
        }
        if !card.summary.isEmpty {
            DetailSection(title: "What changed") { Text(lastEntry(card.summary)).textSelection(.enabled) }
        }
        if !card.notes.isEmpty {
            DetailSection(title: "Notes from runs") {
                Text(lastEntry(card.notes)).font(.callout.monospaced()).lineLimit(12).textSelection(.enabled)
            }
        }
    }
    /// Notes and summaries are appended over time; show the most recent entry.
    private func lastEntry(_ text: String) -> String {
        let parts = text.components(separatedBy: "\n_20")
        guard parts.count > 1, let last = parts.last else { return text }
        return last.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).dropFirst().joined().trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct RouteSection: View {
    @Environment(AppModel.self) private var model
    let card: Card
    let rules: Rules

    var body: some View {
        DetailSection(title: "Route") {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                GridRow {
                    Text("Starts at")
                    Picker("Starts at", selection: Binding(get: { card.tier ?? "" }, set: { v in model.update(card) { $0.tier = v.isEmpty ? nil : v } })) {
                        Text("Follow rules (\(defaultTier))").tag("")
                        Divider()
                        ForEach(rules.ladder, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden().fixedSize()
                }
                GridRow {
                    Text("Agent")
                    Picker("Agent", selection: Binding(get: { card.agent ?? "" }, set: { v in model.update(card) { $0.agent = v.isEmpty ? nil : v } })) {
                        Text("Follow rules").tag("")
                        Divider()
                        ForEach(rules.agents.available, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden().fixedSize()
                }
            }
            .disabled(model.isRunning)
            Text(routeSummary).font(.callout).foregroundStyle(.secondary)
        }
    }

    private var defaultTier: String { card.size.flatMap { rules.tierBySize[$0] } ?? rules.defaultTier }

    private var routeSummary: String {
        let start = rules.ladder.firstIndex(of: card.route.startTier) ?? 0
        let path = rules.ladder[start...].joined(separator: " → ")
        let model = card.route.model.map { " (\($0))" } ?? ""
        return "First attempt: \(card.route.agent)\(model). On failure: \(path), moving up after \(rules.failuresPerTier) failed attempts per tier."
    }
}

struct RulesSection: View {
    @Environment(AppModel.self) private var model
    let state: ProjectState

    var body: some View {
        let r = state.rules
        DetailSection(title: "Rules for this folder") {
            Grid(alignment: .topLeading, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow {
                    Text("Checks").foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(r.verifiers, id: \.self) { v in Text("\(v.name): ").font(.callout) + Text(v.command).font(.callout.monospaced()) }
                    }
                }
                GridRow {
                    Text("Off-limits").foregroundStyle(.secondary)
                    Text(r.forbiddenPaths.joined(separator: "  ")).font(.callout.monospaced())
                }
                GridRow {
                    Text("Limits").foregroundStyle(.secondary)
                    Text("\(r.maxAttempts) attempts, \(r.maxChangedFiles) files changed, \(r.maxCostUsd.formatted(.currency(code: "USD"))) per run")
                }
                GridRow {
                    Text("Branch").foregroundStyle(.secondary)
                    Text(r.branchPattern).font(.callout.monospaced())
                }
                if let review = r.review {
                    GridRow {
                        Text("Review").foregroundStyle(.secondary)
                        Text("\(review.agent) reviews the diff\(review.blocking ? " and can fail the run" : "")")
                    }
                }
                GridRow {
                    Text("Conventions").foregroundStyle(.secondary)
                    Text(state.conventionsApproved ? "Approved" : "Not created yet")
                }
            }
            Button("Open Rules File") { model.open(state.configFile) }
                .help("Opens ungrind.config.yaml in your editor. The app re-reads it when you come back.")
        }
    }
}

struct LastRunSection: View {
    let card: Card
    let run: RunSummary?

    var body: some View {
        DetailSection(title: "Last run") {
            if let run {
                Grid(alignment: .topLeading, horizontalSpacing: 12, verticalSpacing: 6) {
                    GridRow { Text("Result").foregroundStyle(.secondary); Text(run.result + (run.dryRun ? " (dry run)" : "")).fontWeight(.medium).foregroundStyle(run.result == "done" ? .green : .red) }
                    GridRow { Text("When").foregroundStyle(.secondary); Text(when(run.ts)) }
                    GridRow { Text("Tiers").foregroundStyle(.secondary); Text("\(run.path)  ·  \(run.agents)") }
                    GridRow { Text("Cost").foregroundStyle(.secondary); Text("\(run.costUsd.formatted(.currency(code: "USD").precision(.fractionLength(2...3)))) in \(Int(run.durationMs / 1000))s") }
                    if let branch = run.branch {
                        GridRow { Text("Branch").foregroundStyle(.secondary); Text(branch + (run.pushed ? " (pushed)" : " (not pushed)")).font(.callout.monospaced()).textSelection(.enabled) }
                    }
                    if let reason = run.reason {
                        GridRow { Text("Why").foregroundStyle(.secondary); Text(reason).textSelection(.enabled) }
                    }
                }
            } else {
                Text("This card hasn't run yet.").foregroundStyle(.secondary)
            }
        }
    }

    private func when(_ ts: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: ts) else { return ts }
        return d.formatted(date: .abbreviated, time: .shortened)
    }
}

// MARK: - Ship bar and live log

struct ShipBar: View {
    @Environment(AppModel.self) private var model
    let card: Card

    var body: some View {
        let session = model.run.flatMap { $0.cardID == card.id && $0.projectPath == model.selectedPath ? $0 : nil }
        VStack(alignment: .leading, spacing: 8) {
            if let session { RunLog(session: session) }
            HStack {
                if let session, session.isRunning {
                    ProgressView().controlSize(.small)
                    Text(session.outcome).foregroundStyle(.secondary)
                } else if let blocker = card.shipBlocker {
                    Text(blocker).foregroundStyle(.secondary).lineLimit(2)
                } else if model.isRunning {
                    Text("Another card is running.").foregroundStyle(.secondary)
                } else {
                    Text("Ready. Starts at \(card.route.startTier) with \(card.route.agent).").foregroundStyle(.secondary)
                }
                Spacer()
                if let session, session.isRunning {
                    Button("Stop", role: .destructive) { model.stopRun() }
                } else {
                    Button("Dry Run") { model.ship(card, dryRun: true) }
                        .help("Runs the agent and checks on a branch, without pushing or changing the card")
                        .disabled(!card.canShip || model.isRunning)
                    Button("Ship") { model.ship(card, dryRun: false) }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(!card.canShip || model.isRunning)
                }
            }
        }
        .padding(12)
    }
}

struct RunLog: View {
    let session: RunSession
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(session.lines.enumerated()), id: \.offset) { i, line in
                        Text(line.replacingOccurrences(of: "[ungrind] ", with: "")).font(.caption.monospaced()).textSelection(.enabled).id(i)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
            }
            .frame(height: 110)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
            .onChange(of: session.lines.count) { _, n in proxy.scrollTo(n - 1, anchor: .bottom) }
        }
    }
}
