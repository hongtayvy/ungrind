import SwiftUI
import UngrindKit

/// Create or edit a feature card. Saving goes through the engine, which writes the card file.
struct CardEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State var draft: CardDraft
    @State private var criteriaText = ""
    @State private var filesText = ""
    @State private var depsText = ""
    @State private var saving = false

    var body: some View {
        let rules = model.selectedState?.rules
        VStack(spacing: 0) {
            Form {
                Section("Card") {
                    TextField("Title", text: $draft.title, prompt: Text("Add CSV export"))
                    LabeledContent("Goal") {
                        TextEditor(text: $draft.goal).frame(minHeight: 54).font(.body).multilineTextAlignment(.leading)
                    }
                    LabeledContent("Acceptance criteria") {
                        VStack(alignment: .leading, spacing: 2) {
                            TextEditor(text: $criteriaText).frame(minHeight: 70).font(.body).multilineTextAlignment(.leading)
                            Text("One checkable statement per line.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent("Files in scope") {
                        VStack(alignment: .leading, spacing: 2) {
                            TextEditor(text: $filesText).frame(minHeight: 54).font(.body.monospaced()).multilineTextAlignment(.leading)
                            Text("One path or folder per line, relative to the project. The run can't touch anything else.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("Queue") {
                    Picker("Status", selection: $draft.status) {
                        Text("Ready").tag("ready"); Text("In progress").tag("in_progress"); Text("Blocked").tag("blocked"); Text("Shipped").tag("done")
                    }
                    Stepper(value: $draft.priority, in: 0...999) { Text("Priority \(Int(draft.priority)) (lower runs first)") }
                    Picker("Size", selection: opt(\.size)) {
                        Text("Not set").tag(""); Text("Small").tag("small"); Text("Medium").tag("medium"); Text("Large").tag("large")
                    }
                    TextField("Type", text: opt(\.type), prompt: Text("feature, auth, payments…"))
                    TextField("Depends on", text: $depsText, prompt: Text("card ids, comma separated"))
                    if let rules, let t = draft.type, rules.humanApprovalTypes.contains(t) {
                        Toggle("Approved to run (this type needs your sign-off)", isOn: $draft.approved)
                    }
                }
                Section("Route override") {
                    Picker("Starts at", selection: opt(\.tier)) {
                        Text("Follow rules").tag("")
                        ForEach(rules?.ladder ?? [], id: \.self) { Text($0).tag($0) }
                    }
                    Picker("Agent", selection: opt(\.agent)) {
                        Text("Follow rules").tag("")
                        ForEach(rules?.agents.available ?? [], id: \.self) { Text($0).tag($0) }
                    }
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                if let first = current.contractProblems.first {
                    Label(first, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.callout)
                }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(draft.id == nil ? "Create Card" : "Save") {
                    saving = true
                    Task {
                        if await model.save(current) { dismiss() }
                        saving = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(saving || current.title.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(12)
        }
        .frame(width: 560, height: 640)
        .onAppear {
            criteriaText = draft.criteria.joined(separator: "\n")
            filesText = draft.files.joined(separator: "\n")
            depsText = draft.dependencies.joined(separator: ", ")
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
}
