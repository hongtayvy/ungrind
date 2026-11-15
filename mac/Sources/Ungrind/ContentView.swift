import SwiftUI
import UngrindKit

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            ProjectSidebar()
                .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 280)
        } content: {
            CardColumn()
                .navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 480)
        } detail: {
            DetailColumn()
        }
        .sheet(item: $model.editing) { draft in
            CardEditor(draft: draft)
        }
        .alert("Something went wrong", isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } })) {
            Button("OK") { model.alert = nil }
        } message: {
            Text(model.alert ?? "")
        }
        .alert("First pass finished", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button("OK") { model.notice = nil }
        } message: {
            Text(model.notice ?? "")
        }
        .confirmationDialog("This folder has no approved conventions file",
                            isPresented: Binding(get: { model.confirmShipWithoutConventions != nil }, set: { if !$0 { model.confirmShipWithoutConventions = nil } }),
                            presenting: model.confirmShipWithoutConventions) { card in
            Button("Ship Without Conventions") { model.ship(card, dryRun: false, allowWithoutConventions: true) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Agents do better with one. Create it in Terminal with `ungrind onboard`, review the draft, then `ungrind approve`. You can also ship now without it.")
        }
        // Card and rules files can change outside the app, so re-read when the window comes back.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && !model.isRunning { model.reloadSelected() }
        }
    }
}

extension CardDraft: Identifiable {}

// MARK: - Left: folders

struct ProjectSidebar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        List(selection: $model.selectedPath) {
            Section("Folders") {
                ForEach(model.projects) { project in
                    Label(project.name, systemImage: "folder")
                        .tag(project.path)
                        .help(project.path)
                        .contextMenu {
                            Button("Show in Finder") { model.reveal(project.path) }
                            Button("Remove from Ungrind") { model.remove(project) }
                        }
                }
            }
        }
        .overlay {
            if model.projects.isEmpty {
                ContentUnavailableView("No folders yet", systemImage: "folder.badge.plus", description: Text("Add a project folder to see its feature cards."))
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button { model.addFolder() } label: { Label("Add Folder…", systemImage: "plus") }
                .buttonStyle(.borderless)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
        }
    }
}

// MARK: - Middle: the folder's feature cards

struct CardColumn: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let problem = model.engineProblem {
                ContentUnavailableView("Ungrind can't start its engine", systemImage: "exclamationmark.triangle", description: Text(problem))
            } else if let path = model.selectedPath {
                switch model.loads[path] ?? .loading {
                case .loading:
                    ProgressView("Reading folder…").frame(maxWidth: .infinity, maxHeight: .infinity)
                case .needsSetup:
                    ContentUnavailableView {
                        Label("Not set up yet", systemImage: "wand.and.stars")
                    } description: {
                        Text("Ungrind will add a rules file (ungrind.config.yaml) and a tasks folder for feature cards to this folder. Nothing else changes.")
                    } actions: {
                        Button("Set Up Ungrind Here") { model.setUpSelected() }.buttonStyle(.borderedProminent)
                    }
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Couldn't read this folder", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message).textSelection(.enabled)
                    } actions: {
                        Button("Try Again") { model.reloadSelected() }
                    }
                case .ready(let state, _):
                    CardList(state: state)
                }
            } else {
                ContentUnavailableView("Choose a folder", systemImage: "sidebar.left", description: Text("Pick a folder on the left, or add one."))
            }
        }
        .toolbar {
            ToolbarItemGroup {
                Button { model.runFirstPass() } label: { Label("Read Folder", systemImage: "sparkles") }
                    .help("First pass: read this folder with your strongest model and draft feature cards")
                    .disabled(model.selectedState == nil || model.isDiscovering)
                Button { model.reloadSelected() } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    .help("Re-read cards, rules, and runs from the folder")
                    .disabled(model.selectedPath == nil)
                Button { model.newCard() } label: { Label("New Card", systemImage: "plus") }
                    .help("New feature card")
                    .disabled(model.selectedState == nil)
            }
        }
    }
}

struct CardList: View {
    @Environment(AppModel.self) private var model
    let state: ProjectState

    var body: some View {
        @Bindable var model = model
        let cards = state.cards(in: model.tab)
        VStack(spacing: 0) {
            Picker("Tab", selection: $model.tab) {
                ForEach(CardTab.allCases) { tab in
                    Text("\(tab.rawValue) \(state.cards(in: tab).count)").tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(10)

            if model.isDiscovering {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reading the folder and drafting cards. This can take a few minutes.").font(.callout).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.bottom, 8)
            }

            List(cards, selection: $model.selectedCardID) { card in
                CardRow(card: card, isRunning: model.isRunning && model.run?.cardID == card.id)
                    .tag(card.id)
            }
            .overlay {
                if cards.isEmpty && state.cards.isEmpty && !model.isDiscovering {
                    ContentUnavailableView {
                        Label("No cards yet", systemImage: "sparkles")
                    } description: {
                        Text("Ungrind can read this folder and draft its feature cards: what already exists, and unfinished work it finds. It uses your strongest model, reads only, and drafts wait for your review.")
                    } actions: {
                        Button("Read This Folder") { model.runFirstPass() }.buttonStyle(.borderedProminent)
                        Button("New Card") { model.newCard() }
                    }
                } else if cards.isEmpty && !model.isDiscovering {
                    ContentUnavailableView(emptyTitle, systemImage: "rectangle.stack", description: Text(emptyHint))
                }
            }
        }
        .navigationTitle(state.project)
    }

    private var emptyTitle: String {
        switch model.tab {
        case .active: "No active cards"
        case .shipped: "Nothing shipped yet"
        case .archived: "No archived cards"
        }
    }
    private var emptyHint: String {
        switch model.tab {
        case .active: "Create a feature card with the + button."
        case .shipped: "Cards land here when a run passes its checks."
        case .archived: "Archive a card to move it out of the way."
        }
    }
}

struct CardRow: View {
    let card: Card
    let isRunning: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(card.title.isEmpty ? card.id : card.title).font(.headline).lineLimit(2)
                Spacer()
                if isRunning { ProgressView().controlSize(.small) }
                else if !card.problems.isEmpty {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).help(card.problems.joined(separator: "\n"))
                }
            }
            HStack(spacing: 6) {
                StatusPill(card: card)
                Text("\(card.route.startTier) · \(card.route.agent)")
                    .font(.caption).foregroundStyle(.secondary)
                if card.route.overridden {
                    Image(systemName: "arrow.triangle.branch").font(.caption).foregroundStyle(.secondary).help("This card overrides the folder's routing rules")
                }
            }
        }
        .padding(.vertical, 3)
    }
}

struct StatusPill: View {
    let card: Card
    var body: some View {
        Text(card.statusLabel)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }
    private var color: Color {
        if card.draft && card.status != "done" { return .orange }
        return switch card.status {
        case "ready": card.waiting ? .gray : .blue
        case "in_progress": .purple
        case "done": .green
        case "blocked": .red
        default: .gray
        }
    }
}
