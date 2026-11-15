import XCTest
@testable import UngrindKit

final class ModelTests: XCTestCase {
    func card(_ id: String, status: String = "ready", archived: Bool = false, priority: Double? = 1, problems: [String] = [], waiting: Bool = false, needsApproval: Bool = false) -> Card {
        Card(id: id, title: id, goal: "g", criteria: ["c"], files: ["a"], status: status, priority: priority, dependencies: ["dep"], size: nil, type: nil, tier: nil, agent: nil,
             approved: false, archived: archived, problems: problems, waiting: waiting, needsApproval: needsApproval, notes: "", summary: "", file: nil,
             route: Route(startTier: "haiku", agent: "claude-code", model: "m", overridden: false))
    }

    func testTabs() {
        XCTAssertEqual(card("a").tab, .active)
        XCTAssertEqual(card("a", status: "blocked").tab, .active)
        XCTAssertEqual(card("a", status: "done").tab, .shipped)
        XCTAssertEqual(card("a", status: "done", archived: true).tab, .archived)
        XCTAssertEqual(card("a", archived: true).tab, .archived)
    }

    func testShipRules() {
        XCTAssertTrue(card("a").canShip)
        XCTAssertNil(card("a").shipBlocker)
        XCTAssertFalse(card("a", problems: ["missing goal"]).canShip)
        XCTAssertEqual(card("a", problems: ["missing goal"]).shipBlocker, "Fix the card first: missing goal.")
        XCTAssertEqual(card("a", waiting: true).shipBlocker, "Waiting on: dep.")
        XCTAssertEqual(card("a", status: "done").shipBlocker, "Already shipped.")
        XCTAssertFalse(card("a", needsApproval: true).canShip)
        XCTAssertFalse(card("a", archived: true).canShip)
        XCTAssertEqual(card("a", waiting: true).statusLabel, "Waiting")
    }

    func testDraftContract() {
        var d = CardDraft()
        XCTAssertEqual(d.contractProblems.count, 4)
        d.title = "T"; d.goal = "G"; d.criteria = ["", "c"]; d.files = ["src"]
        XCTAssertEqual(d.contractProblems, [])
        let from = CardDraft(card: card("x", status: "unknown:Weird", priority: nil))
        XCTAssertEqual(from.status, "ready")
        XCTAssertEqual(from.priority, 1)
        XCTAssertEqual(from.id, "x")
    }

    func testShellProbeParsing() {
        let noisy = "[oh-my-zsh] update?\n__UG_NODE__/opt/homebrew/bin/node__UG_PATH__/opt/homebrew/bin:/usr/bin__UG_END__"
        let p = EngineEnvironment.parseShellProbe(noisy)
        XCTAssertEqual(p?.node, "/opt/homebrew/bin/node")
        XCTAssertEqual(p?.path, "/opt/homebrew/bin:/usr/bin")
        XCTAssertNil(EngineEnvironment.parseShellProbe("nothing"))
    }

    func testLineBuffer() {
        final class Box: @unchecked Sendable { var lines: [String] = [] }
        let box = Box()
        let b = LineBuffer { box.lines.append($0) }
        b.append(Data("one\ntw".utf8)); b.append(Data("o\nthree".utf8)); b.flush()
        XCTAssertEqual(box.lines, ["one", "two", "three"])
    }
}

/// Runs the real Node engine against a temp folder: init -> save card -> state -> dry run stream.
final class EngineIntegrationTests: XCTestCase {
    func testInitSaveStateRoundTrip() async throws {
        let env = try EngineEnvironment.discover()
        let client = EngineClient(env: env)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ungrind-mac-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let none = try await client.findConfig(dir: dir)
        XCTAssertNil(none)
        let initResult = try await client.initProject(dir: dir)
        XCTAssertTrue(initResult.created)
        let found = try await client.findConfig(dir: dir)
        XCTAssertEqual(found, initResult.configFile)

        var draft = CardDraft()
        draft.title = "Add export"; draft.goal = "Users can export."; draft.criteria = ["Button exists"]; draft.files = ["src/export.js"]
        draft.tier = "opus"; draft.agent = "codex"
        let saved = try await client.save(draft, config: initResult.configFile)
        XCTAssertEqual(saved.id, "add-export")

        var state = try await client.state(config: initResult.configFile)
        XCTAssertEqual(state.rules.ladder, ["haiku", "sonnet", "opus"])
        XCTAssertEqual(state.cards.count, 1)
        let c = state.cards[0]
        XCTAssertEqual(c.route, Route(startTier: "opus", agent: "codex", model: nil, overridden: true))
        XCTAssertTrue(c.canShip)
        XCTAssertEqual(state.cards(in: .active).map(\.id), ["add-export"])

        var edit = CardDraft(card: c)
        edit.archived = true; edit.tier = nil; edit.agent = nil
        _ = try await client.save(edit, config: initResult.configFile)
        state = try await client.state(config: initResult.configFile)
        XCTAssertEqual(state.cards(in: .archived).map(\.id), ["add-export"])
        XCTAssertFalse(state.cards[0].route.overridden)

        do {
            _ = try await client.state(config: dir + "/missing.yaml")
            XCTFail("expected an error")
        } catch let e as EngineError {
            XCTAssertTrue(e.message.contains("Config not found"), e.message)
        }
    }

    func testStreamDeliversLinesAndExitCode() async throws {
        let client = EngineClient(env: try EngineEnvironment.discover())
        final class Box: @unchecked Sendable { var lines: [String] = [] }
        let box = Box()
        let code: Int32 = await withCheckedContinuation { cont in
            _ = client.stream(["help"], onLine: { box.lines.append($0) }, onExit: { cont.resume(returning: $0) })
        }
        XCTAssertEqual(code, 0)
        XCTAssertTrue(box.lines.contains { $0.contains("ungrind: ship your side projects") })
    }
}
