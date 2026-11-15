import SwiftUI
import UngrindKit

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            ProjectSidebar()
                .navigationSplitViewColumnWidth(min: 180, ideal: 208, max: 260)
        } content: {
            CardColumn()
                .navigationSplitViewColumnWidth(min: 280, ideal: 318, max: 400)
        } detail: {
            DetailColumn()
                .frame(minWidth: 440)
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

// MARK: - Left: project folders

struct ProjectSidebar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text("ungrind").font(.system(size: 17, weight: .semibold))
                Text("A little less work.").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 16)
            .accessibilityElement(children: .combine)

            Eyebrow("Projects").padding(.horizontal, 16).padding(.bottom, 6)

            ScrollView {
                VStack(spacing: 2) {
                    ForEach(model.projects) { project in
                        ProjectRow(project: project)
                    }
                }
                .padding(.horizontal, 8)
            }
            .overlay {
                if model.projects.isEmpty {
                    VStack(spacing: 6) {
                        Text("No projects yet").font(.system(size: 13, weight: .semibold))
                        Text("Add a local folder to see its feature cards.").font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    .padding(16)
                }
            }

            Divider()
            Button { model.addFolder() } label: {
                Label("Add folder…", systemImage: "plus").frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .help("Add a project folder (⌘O)")
        }
        .background(Theme.sidebar.ignoresSafeArea())
        .scrollContentBackground(.hidden)
        .toolbarBackground(.hidden, for: .windowToolbar)
    }
}

struct ProjectRow: View {
    @Environment(AppModel.self) private var model
    let project: ProjectRef

    var body: some View {
        let selected = model.selectedPath == project.path
        Button { model.selectedPath = project.path } label: {
            HStack(spacing: 8) {
                Image(systemName: "folder").foregroundStyle(selected ? Theme.accentText : Color.secondary).accessibilityHidden(true)
                Text(project.name).font(.system(size: 13, weight: selected ? .semibold : .regular)).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                if let count = activeCount { Text("\(count)").font(.system(size: 11)).foregroundStyle(.secondary).monospacedDigit() }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Theme.accentWash : Color.clear, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .help(project.path)
        .accessibilityLabel(project.name)
        .accessibilityValue(activeCount.map { "\($0) active cards" } ?? "")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .contextMenu {
            Button("Show in Finder") { model.reveal(project.path) }
            Button("Remove from Ungrind") { model.remove(project) }
        }
    }

    private var activeCount: Int? {
        if case .ready(let state, _)? = model.loads[project.path] { return state.cards(in: .active).count }
        return nil
    }
}

// MARK: - Middle: the project's feature cards

struct CardColumn: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let problem = model.engineProblem {
                StateMessage(symbol: "exclamationmark.triangle", title: "Ungrind can't start its engine", message: problem)
            } else if let path = model.selectedPath {
                switch model.loads[path] ?? .loading {
                case .loading:
                    ProgressView("Reading folder…").controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
                case .needsSetup:
                    StateMessage(symbol: "wand.and.stars", title: "Not set up yet",
                                 message: "Ungrind will add a rules file (ungrind.config.yaml) and a tasks folder for feature cards. It never overwrites an existing file.") {
                        Button("Set Up Ungrind Here") { model.setUpSelected() }.buttonStyle(PrimaryButtonStyle())
                    }
                case .failed(let message):
                    StateMessage(symbol: "exclamationmark.triangle", title: "Couldn't read this folder", message: message) {
                        Button("Try Again") { model.reloadSelected() }
                    }
                case .ready(let state, _):
                    CardList(state: state)
                }
            } else {
                StateMessage(symbol: "folder.badge.plus", title: "Add a project", message: "Choose a local folder. Ungrind shows its feature cards and ships one at a time.") {
                    Button("Add Folder…") { model.addFolder() }.buttonStyle(PrimaryButtonStyle())
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.list.ignoresSafeArea())
        .toolbarBackground(.hidden, for: .windowToolbar)
        .navigationTitle(model.selectedState?.project ?? "Ungrind")
        .toolbar {
            ToolbarItemGroup {
                Button { model.runFirstPass() } label: { Label("Read Folder", systemImage: "sparkles") }
                    .help("First pass: read this folder with your strongest model and draft feature cards")
                    .disabled(model.selectedState == nil || model.isDiscovering)
                Button { model.reloadSelected() } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    .help("Re-read cards, rules, and runs from the folder (⌘R)")
                    .disabled(model.selectedPath == nil)
                Button { model.newCard() } label: { Label("New Card", systemImage: "plus") }
                    .help("New feature card (⌘N)")
                    .disabled(model.selectedState == nil)
            }
        }
    }
}

/// Centered explanation for empty, missing, and error states.
struct StateMessage<Actions: View>: View {
    let symbol: String
    let title: String
    let message: String
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol).font(.system(size: 26)).foregroundStyle(Theme.muted).accessibilityHidden(true)
            Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
            Text(message).font(.system(size: 13)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) { actions }.padding(.top, 4)
        }
        .padding(24)
        .frame(maxWidth: 340)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension StateMessage where Actions == EmptyView {
    init(symbol: String, title: String, message: String) {
        self.init(symbol: symbol, title: title, message: message) { EmptyView() }
    }
}

struct CardList: View {
    @Environment(AppModel.self) private var model
    @FocusState private var searchFocused: Bool
    @FocusState private var listFocused: Bool
    let state: ProjectState

    var body: some View {
        @Bindable var model = model
        let cards = model.visibleCards
        VStack(spacing: 0) {
            Picker("Card status", selection: $model.tab) {
                ForEach(CardTab.allCases) { tab in
                    Text("\(tab.rawValue) \(state.cards(in: tab).count)").tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 12).padding(.top, 10)

            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted).accessibilityHidden(true)
                TextField("Search cards", text: $model.search)
                    .textFieldStyle(.plain)
                    .focused($searchFocused)
                    .onExitCommand { model.search = ""; searchFocused = false }
                    .accessibilityLabel("Search cards by title")
                if !model.search.isEmpty {
                    Button { model.search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear search")
                }
            }
            .font(.system(size: 13))
            .padding(.horizontal, 14).padding(.vertical, 10)
            // ⌘F focuses search.
            .background(Button("") { searchFocused = true }.keyboardShortcut("f").hidden().accessibilityHidden(true))

            HStack {
                Eyebrow("Feature cards")
                Spacer()
                Text("Priority ↑").font(.system(size: 10.5)).foregroundStyle(Theme.muted).accessibilityLabel("Sorted by priority, most urgent first")
            }
            .padding(.horizontal, 14).padding(.bottom, 6)

            if model.isDiscovering {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reading the folder and drafting cards. This can take a few minutes.").font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.bottom, 8)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(cards) { card in
                            CardRow(card: card, selected: card.id == model.selectedCardID, running: model.session(for: card)?.isRunning ?? false)
                                .id(card.id)
                        }
                    }
                    .padding(.horizontal, 8).padding(.bottom, 8)
                }
                // Arrow keys move the selection, like a native list.
                .focusable()
                .focused($listFocused)
                .focusEffectDisabled()
                .onMoveCommand { direction in
                    switch direction {
                    case .down: model.moveSelection(by: 1)
                    case .up: model.moveSelection(by: -1)
                    default: break
                    }
                }
                .onChange(of: model.selectedCardID) { _, id in
                    if let id { proxy.scrollTo(id) }
                }
                .accessibilityLabel("Feature cards")
                .overlay { emptyState(cards) }
            }

            Divider()
            Text(footer).font(.system(size: 11)).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.vertical, 9)
        }
    }

    private var footer: String {
        let n = state.cards.count
        return "\(state.adapter == "local" ? "Local files" : state.adapter.capitalized) · \(n) card\(n == 1 ? "" : "s")"
    }

    @ViewBuilder
    private func emptyState(_ cards: [Card]) -> some View {
        if !cards.isEmpty || model.isDiscovering {
            EmptyView()
        } else if state.cards.isEmpty {
            StateMessage(symbol: "sparkles", title: "No cards yet",
                         message: "Create a card with a goal, acceptance criteria, and the files it can change. Or let Ungrind read this folder and draft cards for you to review; that uses your strongest model and only reads.") {
                Button("New Card") { model.newCard() }.buttonStyle(PrimaryButtonStyle())
                Button("Read This Folder") { model.runFirstPass() }
            }
        } else if !model.search.trimmingCharacters(in: .whitespaces).isEmpty {
            StateMessage(symbol: "magnifyingglass", title: "No matching cards", message: "No \(model.tab.rawValue.lowercased()) card has “\(model.search)” in its title.") {
                Button("Clear Search") { model.search = "" }
            }
        } else {
            switch model.tab {
            case .active: StateMessage(symbol: "rectangle.stack", title: "No active cards", message: "Create a feature card with the + button.")
            case .shipped: StateMessage(symbol: "checkmark.circle", title: "Nothing shipped yet", message: "Cards land here when a run passes its checks.")
            case .archived: StateMessage(symbol: "archivebox", title: "No archived cards", message: "Archive a card to move it out of the way.")
            }
        }
    }
}

struct CardRow: View {
    @Environment(AppModel.self) private var model
    let card: Card
    let selected: Bool
    let running: Bool

    var body: some View {
        let look = CardLook(card, isRunning: running)
        Button { model.selectedCardID = card.id } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(card.title.isEmpty ? card.id : card.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 5) {
                    if running { ProgressView().controlSize(.mini) }
                    else { Image(systemName: look.symbol).font(.system(size: 8)).foregroundStyle(look.foreground).accessibilityHidden(true) }
                    Text(look.short)
                    Text("·").accessibilityHidden(true)
                    Text(card.route.startTier)
                    if card.route.overridden {
                        Image(systemName: "arrow.triangle.branch").font(.system(size: 9)).help("This card overrides the project's routing rules").accessibilityLabel("route override")
                    }
                    Spacer(minLength: 6)
                    if let size = card.size { Text(size.capitalized) }
                }
                .font(.system(size: 11))
                .foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 10).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Theme.raised : Color.clear, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? Theme.line : Color.clear))
            .overlay(alignment: .leading) {
                if selected { RoundedRectangle(cornerRadius: 1.5).fill(Theme.accent).frame(width: 3).padding(.vertical, 10) }
            }
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .help(card.title)
        .accessibilityLabel(card.title.isEmpty ? card.id : card.title)
        .accessibilityValue("\(look.short), starts at \(card.route.startTier)\(card.size.map { ", \($0)" } ?? "")")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .contextMenu {
            Button("Edit…") { model.editing = CardDraft(card: card) }
            if card.status == "blocked" || card.status == "done" {
                Button("Set Back to Ready") { model.update(card) { $0.status = "ready" } }
            }
            Button(card.archived ? "Unarchive" : "Archive") { model.update(card) { $0.archived.toggle() } }
            Divider()
            Button("Open Card File") { model.open(card.file) }
            Button("Show Card in Finder") { model.reveal(card.file) }
        }
    }
}
