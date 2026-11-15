import AppKit
import SwiftUI
import UngrindKit

/// First-launch setup and an anytime health check: is this Mac, and the selected project, ready to run cards?
/// Everything here is read-only except the two conventions buttons, which the user presses.
struct SetupView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Set up Ungrind").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.ink)
                        Text(subtitle).font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }

                    if let problem = model.engineProblem {
                        Banner(symbol: "xmark.octagon.fill", title: "Ungrind can't start its engine", message: problem)
                    } else if let report = model.setup {
                        section("On this Mac", report.checks(in: "tools"))
                        if let project = model.selectedState?.project ?? model.selectedPath.map({ URL(fileURLWithPath: $0).lastPathComponent }) {
                            let checks = report.checks(in: "project")
                            if checks.isEmpty {
                                VStack(alignment: .leading, spacing: 6) {
                                    Eyebrow("Project: \(project)")
                                    Text("This folder isn't set up yet. Close this and choose Set Up Ungrind Here.").font(.system(size: 12)).foregroundStyle(Theme.muted)
                                }
                            } else {
                                section("Project: \(project)", checks, conventions: report.conventions)
                            }
                        } else {
                            VStack(alignment: .leading, spacing: 6) {
                                Eyebrow("Project")
                                Text("No project yet. Add a folder to check that it's ready too.").font(.system(size: 12)).foregroundStyle(Theme.muted)
                                Button("Add Folder…") { model.addFolder(); Task { await model.checkSetup() } }
                            }
                        }
                    } else {
                        HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Checking your setup…").font(.system(size: 12)).foregroundStyle(Theme.muted) }
                    }
                }
                .padding(22)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Divider()
            HStack(spacing: 10) {
                Button { Task { await model.checkSetup() } } label: { Label("Check Again", systemImage: "arrow.clockwise") }
                    .disabled(model.checkingSetup || model.engineProblem != nil)
                if model.checkingSetup { ProgressView().controlSize(.small) }
                Spacer()
                Button(model.setup?.ready == true ? "Done" : "Close") { model.finishSetup() }
                    .buttonStyle(PrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 22).padding(.vertical, 14)
        }
        .frame(width: 580)
        .frame(minHeight: 420, idealHeight: 540, maxHeight: 540)
        .background(Theme.detail)
    }

    private var subtitle: String {
        if model.engineProblem != nil { return "Ungrind runs your cards with tools on this Mac. One of them is missing." }
        return model.setup?.headline ?? "Ungrind runs your cards with tools on this Mac: git, Claude Code, and optionally local models."
    }

    private func section(_ title: String, _ checks: [SetupCheck], conventions: SetupReport.Conventions? = nil) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow(title).padding(.bottom, 8)
            ForEach(checks) { check in
                Divider()
                SetupRow(check: check, conventions: check.id == "conventions" ? conventions : nil)
            }
            Divider()
        }
    }
}

struct SetupRow: View {
    @Environment(AppModel.self) private var model
    let check: SetupCheck
    let conventions: SetupReport.Conventions?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(color).frame(width: 16).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(check.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
                    Text(word).font(.system(size: 11)).foregroundStyle(color)
                }
                Text(check.detail).font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if let fix = check.fix {
                    HStack(spacing: 6) {
                        Text(fix).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.ink).textSelection(.enabled)
                            .padding(.horizontal, 6).padding(.vertical, 3)
                            .background(Theme.neutralWash, in: RoundedRectangle(cornerRadius: 5))
                        Button("Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(fix, forType: .string)
                        }
                        .buttonStyle(.link).font(.system(size: 11))
                        .help("Copy this command, then run it in Terminal")
                    }
                }
                if let conventions, !conventions.approved { conventionsActions(conventions) }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 9)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func conventionsActions(_ c: SetupReport.Conventions) -> some View {
        HStack(spacing: 8) {
            if model.draftingConventions {
                ProgressView().controlSize(.small)
                Text("Reading the project and drafting. This can take a few minutes.").font(.system(size: 11)).foregroundStyle(Theme.muted)
            } else if let draft = c.draft {
                Button("Review Draft") { model.open(draft) }
                    .help("Opens the draft in your editor. Edit it freely before approving.")
                Button("Approve") { model.approveConventions() }
                    .help("Every run will read these conventions from now on")
                Button("Draft Again") { model.draftConventions() }.buttonStyle(.link).font(.system(size: 11))
            } else {
                Button("Draft Conventions") { model.draftConventions() }
                    .disabled(model.selectedState == nil || model.isRunning)
                    .help("Your strongest model reads the project (read-only) and writes a draft for you to review")
            }
        }
        .padding(.top, 2)
    }

    private var symbol: String {
        switch check.status {
        case "ok": "checkmark.circle.fill"
        case "warn": "exclamationmark.triangle.fill"
        case "fail": "xmark.octagon.fill"
        default: "minus.circle"
        }
    }
    private var word: String {
        switch check.status {
        case "ok": "Ready"
        case "warn": "Worth a look"
        case "fail": "Needs fixing"
        default: "Optional"
        }
    }
    private var color: Color {
        switch check.status {
        case "ok": Theme.accentText
        case "warn", "fail": Theme.warnText
        default: Theme.muted
        }
    }
}
