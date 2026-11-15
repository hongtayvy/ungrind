import SwiftUI
import UngrindKit

// MARK: - Right: the selected card as a document, with the ship bar pinned below

struct DetailColumn: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let state = model.selectedState, let card = model.selectedCard {
                GeometryReader { geo in
                    let inset: CGFloat = geo.size.width < 620 ? 24 : 36
                    VStack(spacing: 0) {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 24) {
                                CardHeader(card: card)
                                CardBanners(card: card)
                                CardDocument(card: card)
                                RouteSection(card: card, rules: state.rules)
                                VStack(alignment: .leading, spacing: 0) {
                                    Divider()
                                    RulesDisclosure(state: state)
                                    Divider()
                                    LastRunDisclosure(card: card, run: state.lastRun(for: card.id))
                                    Divider()
                                }
                            }
                            .padding(.horizontal, inset).padding(.top, 28).padding(.bottom, 32)
                            .frame(maxWidth: 760, alignment: .leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        Divider()
                        ShipBar(card: card, lastRun: state.lastRun(for: card.id))
                            .padding(.horizontal, inset).padding(.vertical, 14)
                    }
                }
                .id(card.id) // reset scroll and disclosures when the card changes
            } else if model.selectedState != nil {
                StateMessage(symbol: "rectangle.and.text.magnifyingglass", title: "Select a card", message: "Its goal, scope, route, and last run show up here.")
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.detail.ignoresSafeArea())
        .toolbarBackground(.hidden, for: .windowToolbar)
    }
}

struct CardHeader: View {
    @Environment(AppModel.self) private var model
    let card: Card

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                StatusPill(look: CardLook(card, isRunning: model.session(for: card)?.isRunning ?? false))
                Text(card.id).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                if let meta = metaLine { Text("·").foregroundStyle(Theme.muted).accessibilityHidden(true); Text(meta).font(.system(size: 11)).foregroundStyle(Theme.muted) }
                Spacer(minLength: 8)
                Button("Edit card") { model.editing = CardDraft(card: card) }
                Menu {
                    if card.status == "blocked" || card.status == "done" {
                        Button("Set Back to Ready") { model.update(card) { $0.status = "ready" } }
                    }
                    Button(card.archived ? "Unarchive" : "Archive") { model.update(card) { $0.archived.toggle() } }
                    Divider()
                    Button("Open Card File") { model.open(card.file) }
                    Button("Show Card in Finder") { model.reveal(card.file) }
                } label: {
                    Image(systemName: "ellipsis.circle").accessibilityLabel("More actions")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
            Text(card.title.isEmpty ? card.id : card.title)
                .font(.system(size: 27, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityAddTraits(.isHeader)
            Text(card.goal.isEmpty ? "No goal yet." : card.goal)
                .font(.system(size: 13))
                .lineSpacing(3)
                .foregroundStyle(card.goal.isEmpty ? Theme.muted : Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private var metaLine: String? {
        let parts = [card.size.map { "\($0.capitalized)" }, card.type].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }
}

/// Blockers and drafts, shown before the criteria so the reason is never hidden.
struct CardBanners: View {
    @Environment(AppModel.self) private var model
    let card: Card

    var body: some View {
        if card.draft && card.status != "done" && !card.archived {
            Banner(symbol: "sparkles", title: "Draft from the first pass", message: "Check the goal, criteria, and scope. It won't run until you mark it ready.", warning: false) {
                Button("Mark Ready") { model.update(card) { $0.draft = false } }.disabled(!card.problems.isEmpty)
            }
        }
        if !card.problems.isEmpty {
            Banner(symbol: "exclamationmark.triangle.fill", title: "This card can't run yet", message: card.problems.map { "• \($0)" }.joined(separator: "\n")) {
                Button("Edit card") { model.editing = CardDraft(card: card) }
            }
        } else if card.status == "blocked" {
            Banner(symbol: "exclamationmark.triangle.fill", title: "Blocked by the last run", message: "Read the run notes below, fix the card or the code, then set it back to Ready.") {
                Button("Set Back to Ready") { model.update(card) { $0.status = "ready" } }
            }
        } else if card.waiting {
            Banner(symbol: "clock", title: "Waiting on other cards", message: "Runs after: \(card.dependencies.joined(separator: ", ")).", warning: false)
        } else if card.needsApproval {
            Banner(symbol: "hand.raised", title: "Needs your approval", message: "Cards of type “\(card.type ?? "")” only run after you tick Approved in the editor.", warning: false) {
                Button("Edit card") { model.editing = CardDraft(card: card) }
            }
        }
    }
}

struct CardDocument: View {
    let card: Card
    @State private var showNotes = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle("Acceptance criteria")
            if card.criteria.isEmpty { Text("None yet.").font(.system(size: 13)).foregroundStyle(Theme.muted) }
            // Kept neutral: a passed run does not verify each sentence one by one.
            ForEach(Array(card.criteria.enumerated()), id: \.offset) { _, c in
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    Image(systemName: "circle").font(.system(size: 10)).foregroundStyle(Theme.muted).accessibilityHidden(true)
                    Text(c).font(.system(size: 13)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
            }
        }

        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Files in scope", trailing: card.files.isEmpty ? nil : "\(card.files.count)")
            if card.files.isEmpty {
                Text("No paths added yet.").font(.system(size: 13)).foregroundStyle(Theme.muted)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(card.files, id: \.self) { f in
                        Divider()
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "arrow.turn.down.right").font(.system(size: 9)).foregroundStyle(Theme.muted).accessibilityHidden(true)
                            Text(f).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        }
                        .padding(.vertical, 7)
                    }
                    Divider()
                }
                Text("A run that changes anything outside these paths fails.").font(.system(size: 11)).foregroundStyle(Theme.muted)
            }
        }

        if !card.summary.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionTitle("What changed")
                Text(lastEntry(card.summary)).font(.system(size: 13)).lineSpacing(3).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
        }
        if !card.notes.isEmpty {
            DisclosureGroup(isExpanded: $showNotes) {
                Text(lastEntry(card.notes)).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.ink).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
            } label: {
                SectionTitle("Notes from runs", trailing: "latest entry")
            }
        }
    }

    /// Notes and summaries are appended over time; show the most recent entry.
    private func lastEntry(_ text: String) -> String {
        let parts = text.components(separatedBy: "\n_20")
        guard parts.count > 1, let last = parts.last else {
            // A single entry still starts with its timestamp line.
            let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            if let first = lines.first, first.hasPrefix("_20") { return lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) }
            return text
        }
        return last.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).dropFirst().joined().trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Route

struct RouteSection: View {
    @Environment(AppModel.self) private var model
    let card: Card
    let rules: Rules
    @State private var showOptions = false

    var body: some View {
        GroupSurface {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    SectionTitle("Run route")
                    Spacer()
                    Text(card.route.overridden ? "Card override" : "Follows project rules").font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
                // The real ladder from this card's start tier upward.
                HStack(spacing: 8) {
                    ForEach(Array(ladder.enumerated()), id: \.offset) { i, tier in
                        if i > 0 { Image(systemName: "arrow.right").font(.system(size: 9)).foregroundStyle(Theme.muted).accessibilityHidden(true) }
                        Text(tier)
                            .font(.system(size: 12, weight: i == 0 ? .semibold : .regular))
                            .foregroundStyle(i == 0 ? Theme.accentText : Theme.ink)
                            .padding(.horizontal, i == 0 ? 8 : 0).padding(.vertical, 3)
                            .background(i == 0 ? Theme.accentWash : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Route: \(ladder.joined(separator: ", then "))")
                Text(summary).font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)

                DisclosureGroup(isExpanded: $showOptions) {
                    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                        GridRow {
                            Text("Starts at").font(.system(size: 12))
                            Picker("Starts at", selection: Binding(get: { card.tier ?? "" }, set: { v in model.update(card) { $0.tier = v.isEmpty ? nil : v } })) {
                                Text("Follow rules (\(defaultTier))").tag("")
                                Divider()
                                ForEach(rules.ladder, id: \.self) { Text($0).tag($0) }
                            }
                            .labelsHidden().fixedSize()
                        }
                        GridRow {
                            Text("Agent").font(.system(size: 12))
                            Picker("Agent", selection: Binding(get: { card.agent ?? "" }, set: { v in model.update(card) { $0.agent = v.isEmpty ? nil : v } })) {
                                Text("Follow rules").tag("")
                                Divider()
                                ForEach(rules.agents.available, id: \.self) { Text($0).tag($0) }
                            }
                            .labelsHidden().fixedSize()
                        }
                    }
                    .disabled(model.isRunning)
                    .padding(.top, 8)
                } label: {
                    Text("Route options").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink)
                }
            }
        }
    }

    private var ladder: [String] {
        let start = rules.ladder.firstIndex(of: card.route.startTier) ?? 0
        return Array(rules.ladder[start...])
    }
    private var defaultTier: String { card.size.flatMap { rules.tierBySize[$0] } ?? rules.defaultTier }
    private var summary: String {
        let model = card.route.model.map { " (\($0))" } ?? ""
        let n = rules.failuresPerTier
        let escalate = ladder.count > 1 ? " Moves up a tier after \(n) failed attempt\(n == 1 ? "" : "s")." : ""
        return "Starts with \(card.route.agent)\(model).\(escalate)"
    }
}

// MARK: - Project rules and last run (collapsed by default)

struct RulesDisclosure: View {
    @Environment(AppModel.self) private var model
    let state: ProjectState
    @State private var open = false

    var body: some View {
        let r = state.rules
        DisclosureGroup(isExpanded: $open) {
            VStack(alignment: .leading, spacing: 10) {
                Grid(alignment: .topLeading, horizontalSpacing: 14, verticalSpacing: 7) {
                    row("Checks") {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(r.verifiers, id: \.self) { v in
                                Text("\(v.name): ").font(.system(size: 12)) + Text(v.command).font(.system(size: 12, design: .monospaced))
                            }
                        }
                    }
                    row("Off-limits") { Text(r.forbiddenPaths.joined(separator: "   ")).font(.system(size: 12, design: .monospaced)) }
                    row("Limits") { Text("\(r.maxAttempts) attempts, \(r.maxChangedFiles) changed files, \(r.maxCostUsd.formatted(.currency(code: "USD"))) per run").font(.system(size: 12)) }
                    row("Branch") { Text(r.branchPattern).font(.system(size: 12, design: .monospaced)) }
                    if let review = r.review {
                        row("Review") { Text("\(review.agent) reviews the diff\(review.blocking ? " and can fail the run" : "")").font(.system(size: 12)) }
                    }
                    row("Conventions") { Text(state.conventionsApproved ? "Approved" : "Not created yet. Ship asks before running without one.").font(.system(size: 12)) }
                }
                .foregroundStyle(Theme.ink)
                .textSelection(.enabled)
                HStack(spacing: 8) {
                    Button("Edit Rules…") { model.editRules() }
                        .disabled(model.isRunning)
                        .help(model.isRunning ? "Rules can't change while a run is in progress" : "Edit this project's checks, limits, and route")
                    Button("Open Rules File") { model.open(state.configFile) }
                        .help("Opens ungrind.config.yaml in your editor. The app re-reads it when you come back.")
                }
            }
            .padding(.top, 8).padding(.bottom, 4)
        } label: {
            SectionTitle("Project rules", trailing: state.conventionsApproved ? "Conventions approved" : "No conventions file yet")
        }
        .padding(.vertical, 11)
    }

    private func row<V: View>(_ label: String, @ViewBuilder _ value: () -> V) -> some View {
        GridRow {
            Text(label).font(.system(size: 12)).foregroundStyle(Theme.muted).gridColumnAlignment(.leading)
            value().fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct LastRunDisclosure: View {
    let card: Card
    let run: RunSummary?
    @State private var open: Bool

    init(card: Card, run: RunSummary?) {
        self.card = card
        self.run = run
        _open = State(initialValue: card.status == "done" && run != nil)
    }

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            Group {
                if let run {
                    Grid(alignment: .topLeading, horizontalSpacing: 14, verticalSpacing: 7) {
                        row("Result") { Text(resultText(run)).font(.system(size: 12, weight: .medium)) }
                        row("When") { Text(when(run.ts)).font(.system(size: 12)) }
                        row("Tiers") { Text("\(run.path)   \(run.agents)").font(.system(size: 12)) }
                        row("Cost") { Text("\(run.costUsd.formatted(.currency(code: "USD").precision(.fractionLength(2...3)))) in \(Int(run.durationMs / 1000)) seconds, \(run.attempts) attempt\(run.attempts == 1 ? "" : "s")").font(.system(size: 12)) }
                        if let branch = run.branch {
                            row("Branch") {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(branch).font(.system(size: 12, design: .monospaced))
                                    Text(pushText(run)).font(.system(size: 11)).foregroundStyle(Theme.muted)
                                }
                            }
                        }
                        if let reason = run.reason { row("Why") { Text(reason).font(.system(size: 12)) } }
                    }
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                } else {
                    Text("Run details appear here after the first attempt.").font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8).padding(.bottom, 4)
        } label: {
            SectionTitle("Last run", trailing: run.map(headline) ?? "No previous runs")
        }
        .padding(.vertical, 11)
    }

    private func headline(_ run: RunSummary) -> String {
        (run.result == "done" ? "Checks passed" : run.result.capitalized) + (run.dryRun ? " (dry run)" : "")
    }
    private func resultText(_ run: RunSummary) -> String {
        switch run.result {
        case "done": return run.dryRun ? "Checks passed (dry run: nothing pushed, card unchanged)" : "Checks passed"
        case "blocked": return "Blocked"
        case "skipped": return "Skipped"
        default: return run.result.capitalized
        }
    }
    private func pushText(_ run: RunSummary) -> String {
        if run.dryRun { return "Local branch only. Dry runs don't push." }
        return run.pushed ? "Pushed. Not merged: merging is up to you." : "Not pushed. The branch exists only on this Mac."
    }
    private func when(_ ts: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: ts) else { return ts }
        return d.formatted(date: .abbreviated, time: .shortened)
    }
    private func row<V: View>(_ label: String, @ViewBuilder _ value: () -> V) -> some View {
        GridRow {
            Text(label).font(.system(size: 12)).foregroundStyle(Theme.muted)
            value().fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Ship bar and live output

struct ShipBar: View {
    @Environment(AppModel.self) private var model
    let card: Card
    let lastRun: RunSummary?
    @State private var showOutput = false

    var body: some View {
        let session = model.session(for: card)
        VStack(alignment: .leading, spacing: 10) {
            if let session, showOutput { RunLog(session: session) }
            HStack(alignment: .center, spacing: 12) {
                if session?.isRunning == true { ProgressView().controlSize(.small) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(status(session).title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
                    Text(status(session).detail).font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
                .accessibilityElement(children: .combine)
                Spacer(minLength: 12)
                if session != nil {
                    Button(showOutput ? "Hide output" : "Show output") { showOutput.toggle() }
                        .buttonStyle(.link)
                        .font(.system(size: 12))
                }
                actions(session)
            }
        }
    }

    @ViewBuilder
    private func actions(_ session: RunSession?) -> some View {
        if let session, session.isRunning {
            Button { model.stopRun() } label: { Label(model.stopping ? "Stopping…" : "Stop run", systemImage: "stop.fill") }
                .disabled(model.stopping)
                .help("Asks the engine to stop. The card's real state is re-read when it exits.")
        } else if card.status == "done" && !card.archived {
            Button("Set Back to Ready") { model.update(card) { $0.status = "ready" } }
                .help("Puts the card back in the queue so it can run again")
        } else {
            Button("Dry run") { model.ship(card, dryRun: true) }
                .help("Runs the agent and the checks on a branch, and may commit there. It doesn't push or change the card's status.")
                .accessibilityHint("Runs the agent and checks on a branch without pushing or updating the card")
                .disabled(!card.canShip || model.isRunning)
            Button { model.ship(card, dryRun: false) } label: {
                HStack(spacing: 6) { Text("Ship card"); Text("⌘↩").opacity(0.7).accessibilityHidden(true) }
            }
            .buttonStyle(PrimaryButtonStyle())
            .keyboardShortcut(.return, modifiers: .command)
            .help(card.shipBlocker ?? "Runs this card through the agent loop and pushes its branch when checks pass")
            .disabled(!card.canShip || model.isRunning || model.editing != nil)
        }
    }

    private func status(_ session: RunSession?) -> (title: String, detail: String) {
        if let session {
            if session.isRunning {
                if model.stopping { return ("Stopping…", "Waiting for the engine to exit.") }
                let what = session.dryRun ? "Dry run in progress" : "Working on this card"
                return (what, session.attemptInfo ?? session.latestLine ?? "Starting. You can leave this window.")
            }
            return (session.dryRun ? "Dry run finished" : "Run finished", session.outcome)
        }
        if card.archived { return ("Archived", "Archived cards don't run. Unarchive it from the ••• menu.") }
        if card.status == "done" {
            guard let run = lastRun, run.result == "done", !run.dryRun else { return ("Shipped", "Marked done. No run is recorded for it in this folder.") }
            return ("Checks passed", run.pushed ? "Branch pushed. Not merged." : "Branch not pushed. It exists only on this Mac.")
        }
        if !card.problems.isEmpty && !card.draft { return (blockerTitle, "Fix what's listed above, then ship.") }
        if let blocker = card.shipBlocker { return (blockerTitle, blocker) }
        if model.isRunning {
            let other = model.run.map { $0.projectPath == model.selectedPath ? "“\($0.cardTitle)”" : "a card in another project" } ?? "another card"
            return ("One run at a time", "Ungrind is running \(other).")
        }
        return ("Ready when you are", "Starts at \(card.route.startTier). Changes stay on a separate branch.")
    }

    private var blockerTitle: String {
        if card.draft { return "Draft to review" }
        if !card.problems.isEmpty { return "A little more is needed" }
        if card.waiting { return "Waiting" }
        if card.needsApproval { return "Needs approval" }
        return card.status == "blocked" ? "Blocked" : "Not ready"
    }
}

private struct BottomOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// Selectable, bounded log. Follows new output only while the reader is already near the bottom.
struct RunLog: View {
    let session: RunSession
    @State private var nearBottom = true
    private let height: CGFloat = 130

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(session.lines.enumerated()), id: \.offset) { i, line in
                        Text(line.replacingOccurrences(of: "[ungrind] ", with: "")).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.ink).textSelection(.enabled).id(i)
                    }
                    if session.lines.isEmpty { Text("Waiting for output…").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted) }
                    Color.clear.frame(height: 1).id("bottom")
                        .background(GeometryReader { g in Color.clear.preference(key: BottomOffsetKey.self, value: g.frame(in: .named("log")).maxY) })
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
            }
            .coordinateSpace(name: "log")
            .onPreferenceChange(BottomOffsetKey.self) { maxY in nearBottom = maxY <= height + 40 }
            .frame(height: height)
            .background(Theme.neutralWash.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.line))
            .onChange(of: session.lines.count) { _, _ in if nearBottom { proxy.scrollTo("bottom", anchor: .bottom) } }
            .accessibilityLabel("Run output")
        }
    }
}
