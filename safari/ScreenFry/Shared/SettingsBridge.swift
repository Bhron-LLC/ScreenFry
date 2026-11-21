import Foundation

/// File handoff between the ScreenFry Mac app and one browser's copy of the extension.
/// Browser storage is out of the app's reach, so the extension checks in through native
/// messaging about once a minute: it reports only its version and whether a settings password
/// is on (`check-in.json`), never its settings or usage. Requests chosen in the app wait in
/// files until the next check-in:
///   - `pending-reset.json`   → the extension restores its defaults, answers in `reset-result.json`
///   - `pending-setup.json`  → a loadout from the app's own loadouts, as a share code: the
///     extension applies it as its live setup (or, with a password on, asks for it there),
///     and answers in `setup-result.json`. Each check-in also carries the browser's current
///     setup as a share code (`setupCode`), so the app can save it as one of its loadouts.
///   - `focus.json` → Focus websites (beta, docs/FOCUS.md): whether the browser's tab in front
///     is on one of its Focus websites (`wanted`, yes or no, never which website) and when it
///     said so. Sent the moment it changes (`screenfry-focus`) and with every check-in; the
///     app watches these files and runs the user's Do Not Disturb shortcuts.
///   - `pending-erase.json` → Erase Everything: the extension wipes its storage (Safari keeps an
///     extension's storage after the app is deleted) and Chrome's also removes itself;
///     `erase-sent.json` records that the request was handed over.
///
/// Safari: the sandboxed extension handler uses its own container. Chrome: the app binary,
/// launched by Chrome as a native messaging host, uses Application Support/ScreenFry.
struct SettingsBridge {
    static let checkInName = "check-in.json"
    /// Files from 0.6.x settings export/import, deleted when a browser checks in.
    static let retiredNames = ["settings.json", "pending-import.json", "import-result.json"]
    static let resetName = "pending-reset.json"
    static let resetResultName = "reset-result.json"
    static let setupName = "pending-setup.json"
    static let setupResultName = "setup-result.json"
    static let eraseName = "pending-erase.json"
    static let eraseSentName = "erase-sent.json"
    static let focusName = "focus.json"

    let directory: URL
    var checkInURL: URL { directory.appendingPathComponent(Self.checkInName) }
    var resetURL: URL { directory.appendingPathComponent(Self.resetName) }
    var resetResultURL: URL { directory.appendingPathComponent(Self.resetResultName) }
    var setupURL: URL { directory.appendingPathComponent(Self.setupName) }
    var setupResultURL: URL { directory.appendingPathComponent(Self.setupResultName) }
    var eraseURL: URL { directory.appendingPathComponent(Self.eraseName) }
    var eraseSentURL: URL { directory.appendingPathComponent(Self.eraseSentName) }
    var focusURL: URL { directory.appendingPathComponent(Self.focusName) }

    /// The browser's last Focus signal (beta): wanted or not, and when.
    func focusSignal() -> (wanted: Bool, at: Date)? {
        guard let record = Self.read(focusURL),
              let at = (record["at"] as? String).flatMap({ ISO8601DateFormatter().date(from: $0) })
        else { return nil }
        return (record["wanted"] as? Bool ?? false, at)
    }

    private func writeFocus(_ wanted: Bool, at: String) {
        Self.write(["wanted": wanted, "at": at], to: focusURL)
    }

    /// `<Application Support>/ScreenFry/Bridge/<name>` for the running process (inside a
    /// sandbox this resolves within the container).
    static func local(_ name: String) -> SettingsBridge {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return SettingsBridge(directory: support
            .appendingPathComponent("ScreenFry", isDirectory: true)
            .appendingPathComponent("Bridge", isDirectory: true)
            .appendingPathComponent(name, isDirectory: true))
    }

    /// Answers one `screenfry-sync` message from the extension.
    func handle(_ message: [String: Any]) -> [String: Any] {
        if message["type"] as? String == "screenfry-focus" {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            writeFocus(message["wanted"] as? Bool == true, at: ISO8601DateFormatter().string(from: Date()))
            return ["ok": true]
        }
        guard message["type"] as? String == "screenfry-sync" else {
            return ["ok": false, "error": "Unknown message"]
        }
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let now = ISO8601DateFormatter().string(from: Date())
        Self.write([
            "at": now,
            "version": message["version"] as? String ?? "",
            "passwordProtected": message["passwordProtected"] as? Bool ?? false,
            // Lets the app open ScreenFry's own pages in that browser.
            "extensionId": message["extensionId"] as? String ?? "",
            // The version ScreenFry's running code was built as (0.7.6 on); missing means the
            // browser still runs code from before 0.7.3 whatever its manifest says.
            "codeVersion": message["codeVersion"] as? String ?? "",
            // The browser's live setup as a share code (no usage, history or password).
            "setupCode": message["setupCode"] as? String ?? "",
        ], to: checkInURL)
        // Extensions from before Focus websites send no `focusWanted`; leave their file alone.
        if let wanted = message["focusWanted"] as? Bool { writeFocus(wanted, at: now) }
        for name in Self.retiredNames {
            try? fm.removeItem(at: directory.appendingPathComponent(name))
        }
        if let outcome = message["resetResult"] as? [String: Any], let id = outcome["id"] as? String {
            var record = outcome
            record["at"] = now
            Self.write(record, to: resetResultURL)
            if Self.read(resetURL)?["id"] as? String == id {
                try? fm.removeItem(at: resetURL)
            }
        }
        if let outcome = message["setupResult"] as? [String: Any], let id = outcome["id"] as? String {
            var record = outcome
            record["at"] = now
            Self.write(record, to: setupResultURL)
            if Self.read(setupURL)?["id"] as? String == id {
                try? fm.removeItem(at: setupURL)
            }
        }
        var reply: [String: Any] = ["ok": true]
        if fm.fileExists(atPath: eraseURL.path) {
            reply["erase"] = true
            reply["uninstall"] = true // what 0.6.4–0.6.5 Chrome extensions understand
            Self.write(["at": now], to: eraseSentURL)
            try? fm.removeItem(at: eraseURL)
        } else if let reset = Self.read(resetURL), reset["id"] is String {
            reply["reset"] = reset
        } else if let setup = Self.read(setupURL), setup["id"] is String, setup["code"] is String {
            reply["setup"] = setup
        }
        return reply
    }

    static func read(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    @discardableResult
    static func write(_ object: [String: Any], to url: URL) -> Bool {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        else { return false }
        return (try? data.write(to: url, options: .atomic)) != nil
    }
}
