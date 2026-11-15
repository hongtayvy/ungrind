import SwiftUI
import UngrindKit

/// Edit a project's rules: checks, scope and limits, and the route. Saving goes through the engine,
/// which validates first and writes ungrind.config.yaml, so the app and the file stay in sync.
struct RulesEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let payload: RulesPayload
    @State private var draft: RulesDraft
    @State private var forbiddenText: String
    @State private var approvalText: String
    @State private var showAdvanced = false
    @State private var saving = false
    @State private var saveError: String?

    init(payload: RulesPayload) {
        self.payload = payload
        _draft = State(initialValue: payload.rules)
        _forbiddenText = State(initialValue: payload.rules.forbiddenPaths.joined(separator: "\n"))
        _approvalText = State(initialValue: payload.rules.humanApprovalTypes.joined(separator: ", "))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Project rules").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.ink)
                        Text("These apply to every card in \(model.selectedState?.project ?? "this project"). A card can still override its own route.")
                            .font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    checks
                    Divider()
                    limits
                    Divider()
                    route
                    Divider()
                    DisclosureGroup(isExpanded: $showAdvanced) { advanced.padding(.top, 12) } label: {
                        Text("Advanced: agents, review, approvals, branches").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
                    }
                }
                .padding(22)
            }

            Divider()
            VStack(alignment: .leading, spacing: 8) {
                if let message = saveError ?? current.problems.first {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11)).foregroundStyle(Theme.warnText)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
                HStack(spacing: 10) {
                    if payload.defaults != nil {
                        Button("Reset to Ungrind Defaults") { resetToDefaults() }
                            .help("Restores Ungrind's base limits, route, and guardrails. Your checks are kept.")
                            .disabled(saving)
                    }
                    Spacer()
                    if saving { ProgressView().controlSize(.small) }
                    Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction).disabled(saving)
                    Button("Save rules") { save() }
                        .buttonStyle(PrimaryButtonStyle())
                        .keyboardShortcut(.defaultAction)
                        .disabled(saving || !current.problems.isEmpty)
                }
            }
            .padding(.horizontal, 22).padding(.vertical, 14)
        }
        .frame(width: 620)
        .frame(minHeight: 420, idealHeight: 540, maxHeight: 540)
        .background(Theme.detail)
        .interactiveDismissDisabled(saving)
    }

    // MARK: Checks

    private var checks: some View {
        VStack(alignment: .leading, spacing: 8) {
            heading("Checks", "Commands that must pass after every attempt, run in this order. They are how Ungrind knows a change works.")
            ForEach(draft.verifiers.indices, id: \.self) { i in
                HStack(spacing: 8) {
                    TextField("Name", text: $draft.verifiers[i].name, prompt: Text("tests"))
                        .textFieldStyle(.roundedBorder).frame(width: 120)
                        .accessibilityLabel("Check \(i + 1) name")
                    TextField("Command", text: $draft.verifiers[i].command, prompt: Text("npm test"))
                        .textFieldStyle(.roundedBorder).font(.system(size: 12, design: .monospaced))
                        .accessibilityLabel("Check \(i + 1) command")
                    TextField("Seconds", value: $draft.verifiers[i].timeoutSec, format: .number)
                        .textFieldStyle(.roundedBorder).frame(width: 58).multilineTextAlignment(.trailing)
                        .help("Timeout in seconds").accessibilityLabel("Check \(i + 1) timeout in seconds")
                    Button { move(i, by: -1) } label: { Image(systemName: "arrow.up") }
                        .buttonStyle(.borderless).disabled(i == 0).accessibilityLabel("Move check \(i + 1) up")
                    Button { move(i, by: 1) } label: { Image(systemName: "arrow.down") }
                        .buttonStyle(.borderless).disabled(i == draft.verifiers.count - 1).accessibilityLabel("Move check \(i + 1) down")
                    Button { draft.verifiers.remove(at: i) } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.borderless).accessibilityLabel("Remove check \(i + 1)")
                }
            }
            Button { draft.verifiers.append(.init()) } label: { Label("Add check", systemImage: "plus") }
                .buttonStyle(.borderless)
        }
    }

    // MARK: Scope and limits

    private var limits: some View {
        VStack(alignment: .leading, spacing: 10) {
            heading("Scope and limits", "Every card is also held to its own files in scope. These apply on top.")
            VStack(alignment: .leading, spacing: 5) {
                Text("Off-limits paths").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink)
                TextEditor(text: $forbiddenText)
                    .font(.system(size: 12, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 4).padding(.vertical, 6)
                    .frame(height: 78)
                    .background(Theme.raised, in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.line))
                    .accessibilityLabel("Off-limits paths, one per line")
                Text("One path or pattern per line. A run that touches any of these fails, whatever the card says.").font(.system(size: 11)).foregroundStyle(Theme.muted)
            }
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 8) {
                GridRow {
                    Text("Attempts per card")
                    Stepper(value: $draft.maxAttempts, in: 1...20) { Text("\(draft.maxAttempts)").monospacedDigit() }
                }
                GridRow {
                    Text("Changed files per run")
                    Stepper(value: $draft.maxChangedFiles, in: 1...200) { Text("\(draft.maxChangedFiles)").monospacedDigit() }
                }
                GridRow {
                    Text("Cost ceiling per run")
                    HStack(spacing: 4) {
                        Text("$")
                        TextField("Cost", value: $draft.maxCostUsd, format: .number.precision(.fractionLength(0...2)))
                            .textFieldStyle(.roundedBorder).frame(width: 70).multilineTextAlignment(.trailing)
                            .accessibilityLabel("Cost ceiling per run in dollars")
                    }
                }
            }
            .font(.system(size: 13))
        }
    }

    // MARK: Route

    private var route: some View {
        VStack(alignment: .leading, spacing: 10) {
            heading("Route", "The tiers a card can climb, cheapest first. A run moves up after repeated failures.")
            HStack(spacing: 14) {
                ForEach(tiers, id: \.self) { tier in
                    Toggle(tier, isOn: Binding(get: { draft.ladder.contains(tier) }, set: { on in
                        draft.setTier(tier, enabled: on, order: tiers)
                        if tier == "local" && on && (draft.localModel ?? "").isEmpty { draft.localModel = payload.installedLocalModels.first }
                    }))
                    .toggleStyle(.checkbox)
                }
            }
            if draft.ladder.contains("local") {
                HStack(spacing: 10) {
                    Text("Local model").font(.system(size: 13))
                    if localChoices.isEmpty {
                        Text("No local models found. Start Ollama and install one yourself; Ungrind never downloads models.")
                            .font(.system(size: 11)).foregroundStyle(Theme.warnText).fixedSize(horizontal: false, vertical: true)
                    } else {
                        Picker("Local model", selection: Binding(get: { draft.localModel ?? "" }, set: { draft.localModel = $0.isEmpty ? nil : $0 })) {
                            if (draft.localModel ?? "").isEmpty { Text("Choose…").tag("") }
                            ForEach(localChoices, id: \.self) { Text($0).tag($0) }
                        }
                        .labelsHidden().fixedSize()
                        Text("Runs on this Mac at no cost.").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                }
            }
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 8) {
                GridRow { Text("Small cards start at"); tierPicker("Small cards start at", $draft.tierBySize.small) }
                GridRow { Text("Medium cards start at"); tierPicker("Medium cards start at", $draft.tierBySize.medium) }
                GridRow { Text("Large cards start at"); tierPicker("Large cards start at", $draft.tierBySize.large) }
                GridRow { Text("Cards with no size start at"); tierPicker("Cards with no size start at", $draft.defaultTier) }
                GridRow {
                    Text("Move up after")
                    Stepper(value: $draft.failuresPerTier, in: 1...10) {
                        Text("\(draft.failuresPerTier) failed attempt\(draft.failuresPerTier == 1 ? "" : "s") at a tier").monospacedDigit()
                    }
                }
            }
            .font(.system(size: 13))
        }
    }

    // MARK: Advanced

    private var advanced: some View {
        VStack(alignment: .leading, spacing: 14) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 10) {
                GridRow {
                    Text("Default agent")
                    Picker("Default agent", selection: $draft.agentDefault) {
                        ForEach(payload.agents, id: \.self) { Text($0).tag($0) }
                    }.labelsHidden().fixedSize()
                }
                GridRow {
                    Text("Needs approval")
                    VStack(alignment: .leading, spacing: 3) {
                        TextField("Types", text: $approvalText, prompt: Text("auth, payments, migration")).textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Card types that need approval, comma separated")
                        Text("Card types that only run after you approve them.").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                }
                GridRow {
                    Text("Branch name")
                    VStack(alignment: .leading, spacing: 3) {
                        TextField("Branch", text: $draft.branchPattern).textFieldStyle(.roundedBorder).font(.system(size: 12, design: .monospaced))
                            .accessibilityLabel("Branch name pattern")
                        Text("{slug} becomes the card's title. Ungrind never commits to main.").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                }
            }
            .font(.system(size: 13))
            Toggle("Push the branch when checks pass", isOn: $draft.push)
            VStack(alignment: .leading, spacing: 8) {
                Toggle("Have a second agent review the diff", isOn: $draft.review.enabled)
                if draft.review.enabled {
                    HStack(spacing: 10) {
                        Text("Reviewer")
                        Picker("Reviewer", selection: $draft.review.agent) {
                            ForEach(payload.agents, id: \.self) { Text($0).tag($0) }
                        }.labelsHidden().fixedSize()
                        Toggle("A failed review fails the attempt", isOn: $draft.review.blocking)
                    }
                    .padding(.leading, 20)
                    Text("A different agent than the one that wrote the change catches more.").font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.leading, 20)
                }
            }
        }
        .font(.system(size: 13))
    }

    // MARK: Helpers

    private var tiers: [String] {
        payload.knownTiers + draft.ladder.filter { !payload.knownTiers.contains($0) }
    }

    private var localChoices: [String] {
        var out = payload.installedLocalModels
        if let m = draft.localModel, !m.isEmpty, !out.contains(m) { out.insert(m, at: 0) }
        return out
    }

    /// The draft with the text fields folded back into lists.
    private var current: RulesDraft {
        var d = draft
        d.forbiddenPaths = forbiddenText.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        d.humanApprovalTypes = approvalText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return d
    }

    private func heading(_ title: String, _ hint: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
            Text(hint).font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func tierPicker(_ label: String, _ selection: Binding<String>) -> some View {
        Picker(label, selection: selection) {
            ForEach(draft.ladder, id: \.self) { Text($0).tag($0) }
        }
        .labelsHidden().fixedSize()
    }

    private func move(_ i: Int, by offset: Int) {
        let j = i + offset
        guard draft.verifiers.indices.contains(j) else { return }
        draft.verifiers.swapAt(i, j)
    }

    private func resetToDefaults() {
        guard var d = payload.defaults else { return }
        d.verifiers = draft.verifiers // checks are the project's own; keep them
        draft = d
        forbiddenText = d.forbiddenPaths.joined(separator: "\n")
        approvalText = d.humanApprovalTypes.joined(separator: ", ")
        saveError = nil
    }

    private func save() {
        guard !saving else { return }
        saving = true
        saveError = nil
        Task {
            // On failure nothing is written and the sheet stays open with everything as typed.
            if let error = await model.saveRules(current) { saveError = error } else { dismiss() }
            saving = false
        }
    }
}
