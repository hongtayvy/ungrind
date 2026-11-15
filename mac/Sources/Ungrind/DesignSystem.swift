import AppKit
import SwiftUI
import UngrindKit

// Ungrind's look: a warm neutral workspace with one amber accent (#EA9828).
// Colors adapt to light/dark and to Increase Contrast. Everything else is system typography and native controls.

extension Color {
    /// An adaptive color. `hcLight` / `hcDark` are used when Increase Contrast is on (default: the normal values).
    init(light: UInt32, dark: UInt32, hcLight: UInt32? = nil, hcDark: UInt32? = nil) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            let match = appearance.bestMatch(from: [.aqua, .darkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua])
            switch match {
            case .darkAqua: return NSColor(hex: dark)
            case .accessibilityHighContrastAqua: return NSColor(hex: hcLight ?? light)
            case .accessibilityHighContrastDarkAqua: return NSColor(hex: hcDark ?? dark)
            default: return NSColor(hex: light)
            }
        })
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

enum Theme {
    // Surfaces
    static let detail = Color(light: 0xFDFDFB, dark: 0x292F2A)
    static let list = Color(light: 0xF8F8F5, dark: 0x252B26)
    static let sidebar = Color(light: 0xEFEFEB, dark: 0x222723)
    static let raised = Color(light: 0xFFFFFF, dark: 0x303832)

    // Text and lines
    static let ink = Color(light: 0x242A27, dark: 0xEEF1EB, hcLight: 0x000000, hcDark: 0xFFFFFF)
    static let muted = Color(light: 0x686F69, dark: 0xA5AFA5, hcLight: 0x3A403B, hcDark: 0xD5DCD4)
    static let line = Color(light: 0xE3E6DF, dark: 0x3D453D, hcLight: 0x8C938B, hcDark: 0x8A948A)

    // Accent: #EA9828. The fill is the same in both appearances; text on it is dark for contrast.
    static let accent = Color(light: 0xEA9828, dark: 0xEA9828, hcLight: 0xC77A0E, hcDark: 0xF5B050)
    static let onAccent = Color(light: 0x2B1B02, dark: 0x2B1B02, hcLight: 0x000000, hcDark: 0x000000)
    /// Accent used as text or a small symbol on a surface (darker in light mode so it stays readable).
    static let accentText = Color(light: 0x8A5208, dark: 0xF2B45E, hcLight: 0x5E3600, hcDark: 0xFFD08A)
    static let accentWash = Color(light: 0xFBEFDD, dark: 0x4A3A20)

    // Warnings (always paired with a symbol and text, never color alone)
    static let warnText = Color(light: 0x8A3B12, dark: 0xF0A98A, hcLight: 0x5C1F00, hcDark: 0xFFC9B0)
    static let warnSurface = Color(light: 0xF9E9E1, dark: 0x452C22)

    static let neutralWash = Color(light: 0xECEEE8, dark: 0x363D37)
}

/// What a card looks like to a person, derived from the engine's fields.
enum CardLook {
    case ready, waiting, running, attention, draft, shipped, archived

    init(_ card: Card, isRunning: Bool = false) {
        if card.archived { self = .archived }
        else if isRunning || card.status == "in_progress" { self = .running }
        else if card.status == "done" { self = .shipped }
        else if card.draft { self = .draft }
        else if card.status == "blocked" || !card.problems.isEmpty || card.status.hasPrefix("unknown") { self = .attention }
        else if card.waiting || card.needsApproval { self = .waiting }
        else { self = .ready }
    }

    /// Short label for list rows.
    var short: String {
        switch self {
        case .ready: "Ready"
        case .waiting: "Waiting"
        case .running: "Running"
        case .attention: "Blocked"
        case .draft: "Draft"
        case .shipped: "Shipped"
        case .archived: "Archived"
        }
    }

    /// Longer label for the detail header.
    var long: String {
        switch self {
        case .ready: "Ready to run"
        case .waiting: "Waiting"
        case .running: "In progress"
        case .attention: "Needs attention"
        case .draft: "Draft to review"
        case .shipped: "Shipped"
        case .archived: "Archived"
        }
    }

    var symbol: String {
        switch self {
        case .ready: "circle.fill"
        case .waiting: "clock"
        case .running: "arrow.triangle.2.circlepath"
        case .attention: "exclamationmark.triangle.fill"
        case .draft: "sparkles"
        case .shipped: "checkmark.circle.fill"
        case .archived: "archivebox"
        }
    }

    var foreground: Color {
        switch self {
        case .ready, .running, .shipped: Theme.accentText
        case .attention: Theme.warnText
        case .waiting, .draft, .archived: Theme.muted
        }
    }

    var wash: Color {
        switch self {
        case .ready, .running, .shipped: Theme.accentWash
        case .attention: Theme.warnSurface
        case .waiting, .draft, .archived: Theme.neutralWash
        }
    }
}

/// Status as a tinted capsule with a symbol and text.
struct StatusPill: View {
    let look: CardLook
    var body: some View {
        Label(look.long, systemImage: look.symbol)
            .labelStyle(.titleAndIcon)
            .font(.system(size: 11, weight: .semibold))
            .imageScale(.small)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 8).padding(.vertical, 3)
            .foregroundStyle(look.foreground)
            .background(look.wash, in: RoundedRectangle(cornerRadius: 6))
            .accessibilityLabel("Status: \(look.long)")
    }
}

/// The one dominant action: an amber fill with dark text.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .padding(.horizontal, 14).padding(.vertical, 6)
            .foregroundStyle(Theme.onAccent)
            .background(Theme.accent.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 6))
            .opacity(enabled ? 1 : 0.4)
            .contentShape(RoundedRectangle(cornerRadius: 6))
    }
}

/// Small uppercase label above a list or group.
struct Eyebrow: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10.5, weight: .semibold))
            .kerning(0.6)
            .foregroundStyle(Theme.muted)
    }
}

/// Section heading inside the detail document.
struct SectionTitle: View {
    let text: String
    var trailing: String?
    init(_ text: String, trailing: String? = nil) { self.text = text; self.trailing = trailing }
    var body: some View {
        HStack(spacing: 8) {
            Text(text).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
            if let trailing { Text(trailing).font(.system(size: 11)).foregroundStyle(Theme.muted) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A banner for blockers and drafts: symbol, bold line, explanation, optional action.
struct Banner<Action: View>: View {
    let symbol: String
    let title: String
    let message: String
    var warning = true
    @ViewBuilder var action: Action

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(warning ? Theme.warnText : Theme.accentText).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
                Text(message).font(.system(size: 13)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            Spacer(minLength: 8)
            action
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(warning ? Theme.warnSurface : Theme.accentWash, in: RoundedRectangle(cornerRadius: 8))
    }
}

extension Banner where Action == EmptyView {
    init(symbol: String, title: String, message: String, warning: Bool = true) {
        self.init(symbol: symbol, title: title, message: message, warning: warning) { EmptyView() }
    }
}

/// A hairline-bordered group, used for the route and for disclosures.
struct GroupSurface<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.line))
    }
}
