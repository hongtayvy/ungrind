import SwiftUI
import UngrindKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Needed when launched as a bare executable (swift run); harmless inside the .app bundle.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        // For checking the design: UNGRIND_APPEARANCE=dark|light forces an appearance for this launch.
        switch ProcessInfo.processInfo.environment["UNGRIND_APPEARANCE"] {
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        default: break
        }
    }
}

@main
struct UngrindApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        Window("Ungrind", id: "main") {
            ContentView()
                .environment(model)
                .frame(minWidth: 980, minHeight: 600)
        }
        .defaultSize(width: 1252, height: 780)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Setup Check…") {
                    model.showSetup = true
                    Task { await model.checkSetup() }
                }
            }
            CommandGroup(replacing: .newItem) {
                Button("New Card") { model.newCard() }
                    .keyboardShortcut("n")
                    .disabled(model.selectedState == nil)
                Button("Add Folder…") { model.addFolder() }
                    .keyboardShortcut("o")
                Button("Edit Rules…") { model.editRules() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    .disabled(model.selectedState == nil || model.isRunning)
                Button("Reload") { model.reloadSelected() }
                    .keyboardShortcut("r")
            }
        }

        MenuBarExtra {
            MenuBarContent().environment(model)
        } label: {
            Image(systemName: model.isRunning ? "shippingbox.fill" : "shippingbox")
        }
    }
}

struct MenuBarContent: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let run = model.run {
            Text(run.cardTitle)
            Text(run.outcome)
            if run.isRunning { Button("Stop Run") { model.stopRun() } }
        } else {
            Text("No runs yet this session")
        }
        Divider()
        Button("Open Ungrind") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        Button("Quit Ungrind") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
