import SwiftUI
import UngrindKit

/// Create or edit a feature card. Required fields first; queue and route fields sit in an Advanced disclosure.
/// Saving goes through the engine, which writes the card file.
struct CardEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State var draft: CardDraft
    @State private var criteriaText = ""
    @State private var filesText = ""
    @State private var depsText = ""
    @State private var saving = false
    @State private var showAdvanced = false
    @State private var triedToSave = false
    @FocusState private var titleFocused: Bool

    var body: some View {
        let rules = model.selectedState?.rules
        let isNew = draft.id == nil
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(isNew ? "New feature card" : "Edit feature card").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.ink)
                        Text("Give the agent a clear goal and a small scope.").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }

                    field("Title", problem: showProblems && isBlank(draft.title) ? "Add a title. A card can't be saved without one." : nil) {
                        TextField("Title", text: $draft.title, prompt: Text("Add CSV export"))
                            .textFieldStyle(.roundedBorder)
                            .labelsHidden()
                            .focused($titleFocused)
                    }
                    field("Goal", hint: "One or two sentences on what is true when this is done.",
                          problem: showProblems && isBlank(draft.goal) ? "Add a goal so the card can run." : nil) {
                        editor($draft.goal, height: 58, label: "Goal")
                    }
                    field("Acceptance criteria", hint: "One checkable statement per line.",
                          problem: showProblems && current.criteria.isEmpty ? "Add at least one criterion so the card can run." : nil) {
                        editor($criteriaText, height: 78, label: "Acceptance criteria")
                    }
                    field("Files in scope", hint: "One path or folder per line, relative to the project. A run can't change anything else.",
                          problem: showProblems && current.files.isEmpty ? "Add at least one path so the card can run." : nil) {
                        editor($filesText, height: 58, mono: true, label: "Files in scope")
                    }

                    // Gated types need sign-off; keep this visible even when Advanced is closed.
                    if let rules, let t = draft.type, rules.humanApprovalTypes.contains(t) {
                        Toggle(isOn: $draft.approved) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Approved to run").font(.system(size: 13))
                                Text("Cards of type “\(t)” only run after your sign-off.").font(.system(size: 11)).foregroundStyle(Theme.muted)
                            }
                        }
                    }

                    Divider()
                    DisclosureGroup(isExpanded: $showAdvanced) {
                        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 10) {
                            GridRow {
                                Text("Status")
                                Picker("Status", selection: $draft.status) {
                                    Text("Ready").tag("ready"); Text("In progress").tag("in_progress"); Text("Blocked").tag("blocked"); Text("Shipped").tag("done")
                                }.labelsHidden().fixedSize()
                            }
                            GridRow {
                                Text("Priority")
                                Stepper(value: $draft.priority, in: 0...999) { Text("\(Int(draft.priority))   lower runs first").monospacedDigit() }
                            }
                            GridRow {
                                Text("Size")
                                Picker("Size", selection: opt(\.size)) {
                                    Text("Not set").tag(""); Text("Small").tag("small"); Text("Medium").tag("medium"); Text("Large").tag("large")
                                }.labelsHidden().fixedSize()
                            }
                            GridRow {
                                Text("Type")
                                TextField("Type", text: opt(\.type), prompt: Text("feature, auth, payments…")).textFieldStyle(.roundedBorder).labelsHidden()
                            }
                            GridRow {
                                Text("Depends on")
                                TextField("Depends on", text: $depsText, prompt: Text("card ids, comma separated")).textFieldStyle(.roundedBorder).labelsHidden()
                            }
                            GridRow {
                                Text("Starts at")
                                Picker("Starts at", selection: opt(\.tier)) {
                                    Text("Follow project rules").tag("")
                                    ForEach(rules?.ladder ?? [], id: \.self) { Text($0).tag($0) }
                                }.labelsHidden().fixedSize()
                            }
                            GridRow {
                                Text("Agent")
                                Picker("Agent", selection: opt(\.agent)) {
                                    Text("Follow project rules").tag("")
                                    ForEach(rules?.agents.available ?? [], id: \.self) { Text($0).tag($0) }
                                }.labelsHidden().fixedSize()
                            }
                        }
                        .font(.system(size: 13))
                        .padding(.top, 10)
                    } label: {
                        Text("Advanced: queue and route").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
                    }
                }
                .padding(22)
            }

            Divider()
            HStack(spacing: 10) {
                if !isBlank(draft.title) && !current.contractProblems.isEmpty {
                    Label("You can save this now, but it can't run until it's complete.", systemImage: "info.circle")
                        .font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(saving)
                Button(isNew ? "Create card" : "Save card") { save() }
                    .buttonStyle(PrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving)
            }
            .padding(.horizontal, 22).padding(.vertical, 14)
        }
        .frame(width: 560)
        .frame(minHeight: 480, idealHeight: 600, maxHeight: 680)
        .background(Theme.detail)
        .interactiveDismissDisabled(saving)
        .onAppear {
            criteriaText = draft.criteria.joined(separator: "\n")
            filesText = draft.files.joined(separator: "\n")
            depsText = draft.dependencies.joined(separator: ", ")
            triedToSave = !isNew // show what's missing right away on an existing card
            // Open Advanced when the card already uses any of it, so nothing is hidden.
            showAdvanced = !isNew && (draft.tier != nil || draft.agent != nil || !draft.dependencies.isEmpty || draft.status != "ready")
            titleFocused = isNew
        }
    }

    private var showProblems: Bool { triedToSave }
    private func isBlank(_ s: String) -> Bool { s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func save() {
        triedToSave = true
        guard !isBlank(draft.title), !saving else { titleFocused = true; return }
        saving = true
        Task {
            // On failure the sheet stays open with everything the user typed; the model shows the error.
            if await model.save(current) { dismiss() }
            saving = false
        }
    }

    /// The draft with the multi-line text fields folded back into lists.
    private var current: CardDraft {
        var d = draft
        d.criteria = lines(criteriaText).map { $0.replacingOccurrences(of: #"^[-*]\s+"#, with: "", options: .regularExpression) }
        d.files = lines(filesText)
        d.dependencies = depsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return d
    }

    private func lines(_ s: String) -> [String] {
        s.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private func opt(_ key: WritableKeyPath<CardDraft, String?>) -> Binding<String> {
        Binding(get: { draft[keyPath: key] ?? "" }, set: { draft[keyPath: key] = $0.isEmpty ? nil : $0 })
    }

    private func field<Content: View>(_ label: String, hint: String? = nil, problem: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
            content()
            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(Theme.warnText)
            } else if let hint {
                Text(hint).font(.system(size: 11)).foregroundStyle(Theme.muted)
            }
        }
    }

    private func editor(_ text: Binding<String>, height: CGFloat, mono: Bool = false, label: String) -> some View {
        TextEditor(text: text)
            .font(.system(size: 13, design: mono ? .monospaced : .default))
            .multilineTextAlignment(.leading)
            .scrollContentBackground(.hidden)
            .padding(.horizontal, 4).padding(.vertical, 6)
            .frame(minHeight: height)
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.line))
            .accessibilityLabel(label)
    }
}
