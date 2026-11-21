import AppKit

#if !APPSTORE
/// Focus websites (beta, docs/FOCUS.md): while a browser's tab in front is one of its Focus
/// websites, turn on Do Not Disturb, and turn it off 10 seconds after none is.
///
/// macOS has no public way to set a Focus, so this runs two shortcuts the user adds once,
/// "ScreenFry Focus On" and "ScreenFry Focus Off" (each a Set Focus action), with
/// `/usr/bin/shortcuts`. The browsers write only "wanted: yes or no" to their bridge folders
/// (`focus.json`, see Shared/SettingsBridge.swift); this watches those folders. Nothing leaves
/// the Mac. Left out of the Mac App Store build, whose sandbox can't run `shortcuts`.
final class FocusController {
    static let onShortcut = "ScreenFry Focus On"
    static let offShortcut = "ScreenFry Focus Off"
    private static let enabledKey = "focusWhileBrowsing"
    /// ScreenFry's On shortcut turned Do Not Disturb on and its Off shortcut hasn't run since.
    /// Kept across launches, so a ScreenFry that quit unexpectedly still turns it off.
    private static let ownedKey = "focusTurnedOnByScreenFry"

    /// The window's switch; on unless turned off (the browsers' lists are the real choice).
    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }
    static var turnedOnByScreenFry: Bool { UserDefaults.standard.bool(forKey: ownedKey) }

    private var focusSwitch = FocusSwitch(on: FocusController.turnedOnByScreenFry)
    /// Runs the shortcuts one at a time, in order.
    private let runner = DispatchQueue(label: "com.screenfry.focus")
    private var watchers: [SettingsBrowser: DispatchSourceFileSystemObject] = [:]
    private var checkTimer: Timer?
    private var safetyTimer: Timer?
    private var observers: [NSObjectProtocol] = []
    /// Which of the two shortcuts exist, once looked up.
    private(set) var installed: (on: Bool, off: Bool)?
    private(set) var lastError: String?
    /// Called on the main queue whenever what the window shows may have changed.
    var onChange: (() -> Void)?

    func start() {
        watch()
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didTerminateApplicationNotification, NSWorkspace.didLaunchApplicationNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                let id = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier
                if SettingsBrowser.allCases.contains(where: { $0.bundleID == id }) { self?.evaluate() }
            })
        }
        // Folders that didn't exist yet get watched once they do; stale signals expire.
        safetyTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.watch()
            self?.evaluate()
        }
        refreshInstalled()
        evaluate()
    }

    /// The window's switch.
    func setEnabled(_ on: Bool) {
        Self.enabled = on
        if !on, let command = focusSwitch.stop() { run(command) }
        evaluate()
    }

    /// Quitting: turn off a Do Not Disturb ScreenFry turned on, before the app goes.
    func stopForQuit() {
        _ = focusSwitch.stop()
        runner.sync {
            guard Self.turnedOnByScreenFry else { return }
            _ = Self.runShortcut(Self.offShortcut, timeout: 8)
            UserDefaults.standard.set(false, forKey: Self.ownedKey)
        }
    }

    /// What the browsers say, and whether to run a shortcut now.
    func evaluate() {
        let now = Date()
        let running = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
        let signals = SettingsBrowser.allCases.compactMap { browser -> FocusSwitch.Signal? in
            guard let signal = browser.bridge.focusSignal() else { return nil }
            return FocusSwitch.Signal(wanted: signal.wanted, at: signal.at, browserRunning: running.contains(browser.bundleID))
        }
        let wanted = Self.enabled && FocusSwitch.wanted(signals, now: now)
        let (command, nextCheck) = focusSwitch.update(wanted: wanted, now: now)
        if let command { run(command) }
        checkTimer?.invalidate()
        checkTimer = nil
        let expiry = Self.enabled ? FocusSwitch.nextExpiry(signals, now: now) : nil
        if let next = [nextCheck, expiry].compactMap({ $0 }).min() {
            checkTimer = Timer.scheduledTimer(withTimeInterval: max(0.2, next.timeIntervalSince(now) + 0.05), repeats: false) { [weak self] _ in
                self?.evaluate()
            }
        }
        onChange?()
    }

    /// Whether a Focus website wants Do Not Disturb right now (shown in the window).
    var isOn: Bool { focusSwitch.on }

    /// Looks up which of the two shortcuts exist (`shortcuts list`).
    func refreshInstalled() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let names = Self.shortcutNames()
            DispatchQueue.main.async {
                self?.installed = names.map { ($0.contains(Self.onShortcut), $0.contains(Self.offShortcut)) }
                self?.onChange?()
            }
        }
    }

    private func run(_ command: FocusSwitch.Command) {
        runner.async { [weak self] in
            var error: String?
            switch command {
            case .turnOn:
                let result = Self.runShortcut(Self.onShortcut)
                // A shortcut that outputs "already" found a Focus on before ScreenFry; that
                // one is left alone when you leave (docs/FOCUS.md).
                let already = result.output.lowercased().contains("already")
                UserDefaults.standard.set(result.ok && !already, forKey: Self.ownedKey)
                error = result.error
            case .turnOff:
                // Only a Do Not Disturb ScreenFry turned on is turned off.
                guard Self.turnedOnByScreenFry else { break }
                error = Self.runShortcut(Self.offShortcut).error
                UserDefaults.standard.set(false, forKey: Self.ownedKey)
            }
            DispatchQueue.main.async {
                self?.lastError = error
                if error != nil { self?.refreshInstalled() }
                self?.onChange?()
            }
        }
    }

    // MARK: Watching the browsers' bridge folders

    private func watch() {
        for browser in SettingsBrowser.allCases where watchers[browser] == nil {
            let directory = browser.bridge.directory
            // Chrome's folder is this app's own; Safari's is inside its extension's container.
            if browser == .chrome {
                try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            }
            let fd = open(directory.path, O_EVTONLY)
            guard fd >= 0 else { continue }
            let source = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd, eventMask: [.write, .delete, .rename], queue: .main)
            source.setEventHandler { [weak self, weak source] in
                // The folder itself went away: watch it again once it's back.
                if let events = source?.data, !events.isDisjoint(with: [.delete, .rename]) {
                    source?.cancel()
                    self?.watchers[browser] = nil
                }
                self?.evaluate()
            }
            source.setCancelHandler { close(fd) }
            source.resume()
            watchers[browser] = source
        }
    }

    // MARK: Shortcuts

    /// The user's shortcut names, or nil when `shortcuts` couldn't run.
    static func shortcutNames() -> Set<String>? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/shortcuts")
        process.arguments = ["list"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        let text = String(data: data, encoding: .utf8) ?? ""
        return Set(text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) })
    }

    /// Runs one shortcut and waits for it (at most `timeout`), with its text output if any.
    static func runShortcut(_ name: String, timeout: TimeInterval = 20) -> (ok: Bool, output: String, error: String?) {
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("screenfry-focus-\(UUID().uuidString).txt")
        defer { try? FileManager.default.removeItem(at: outputURL) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/shortcuts")
        process.arguments = ["run", name, "--output-path", outputURL.path]
        let errors = Pipe()
        process.standardError = errors
        process.standardOutput = FileHandle.nullDevice
        do { try process.run() } catch {
            return (false, "", "Couldn’t run the shortcut “\(name)”: \(error.localizedDescription)")
        }
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline { usleep(50_000) }
        if process.isRunning {
            process.terminate()
            return (false, "", "The shortcut “\(name)” didn’t finish.")
        }
        let output = (try? String(contentsOf: outputURL, encoding: .utf8)) ?? ""
        guard process.terminationStatus == 0 else {
            let message = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return (false, output, message.isEmpty ? "The shortcut “\(name)” couldn’t run." : message)
        }
        return (true, output, nil)
    }
}

/// The window's Focus card: the switch, the shortcuts' status and how to add them.
final class FocusPanel: NSObject {
    private let controller: FocusController
    private lazy var enabledBox = NSButton(
        checkboxWithTitle: "Turn on Do Not Disturb while a Focus website is the tab in front",
        target: self, action: #selector(toggle(_:)))
    let status = NSTextField(labelWithString: "Beta")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let shortcutsLabel = NSTextField(labelWithString: "")

    init(controller: FocusController) {
        self.controller = controller
        super.init()
    }

    func makeRows(button: (String, Selector, Bool) -> NSButton, helper: (String) -> NSTextField) -> [NSView] {
        enabledBox.state = FocusController.enabled ? .on : .off
        detail.font = .systemFont(ofSize: 12)
        detail.preferredMaxLayoutWidth = 540
        shortcutsLabel.font = .systemFont(ofSize: 12, weight: .medium)
        let open = button("New Shortcut", #selector(openShortcuts(_:)), false)
        open.target = self
        open.toolTip = "Open the Shortcuts app to make the two shortcuts."
        let check = button("Check Again", #selector(checkAgain(_:)), false)
        check.target = self
        let buttons = NSStackView(views: [open, check])
        buttons.spacing = 8
        let rows: [NSView] = [
            enabledBox,
            detail,
            shortcutsLabel,
            helper("In Shortcuts, make two shortcuts named exactly “\(FocusController.onShortcut)” and “\(FocusController.offShortcut)”, each with one Set Focus action: turn Do Not Disturb on (until turned off) in the first, and off in the second. ScreenFry runs them with macOS’s shortcuts command; nothing leaves this Mac."),
            helper("Choose the websites in ScreenFry’s Settings in each browser, under Focus while browsing. The browsers tell this app only “on” or “off”, never which website. Do Not Disturb turns off 10 seconds after you leave them. To keep a Do Not Disturb you turned on yourself, start the On shortcut with Get Current Focus, and if one is on, Stop and Output the text “already”."),
            buttons,
        ]
        controller.onChange = { [weak self] in self?.refresh() }
        refresh()
        return rows
    }

    func refresh() {
        let installed = controller.installed
        func mark(_ name: String, _ present: Bool?) -> String {
            switch present {
            case true?: return "✓ \(name)"
            case false?: return "✗ \(name) is missing"
            case nil: return "… \(name)"
            }
        }
        shortcutsLabel.stringValue = [
            mark(FocusController.onShortcut, installed?.on),
            mark(FocusController.offShortcut, installed?.off),
        ].joined(separator: "   ")
        let ready = installed.map { $0.on && $0.off } ?? false
        if let error = controller.lastError {
            detail.stringValue = error
            detail.textColor = .systemOrange
        } else {
            detail.textColor = .secondaryLabelColor
            detail.stringValue = !FocusController.enabled
                ? "Off. Focus websites in your browsers don’t change Do Not Disturb."
                : !ready
                    ? "Add the two shortcuts below to start."
                    : controller.isOn
                        ? (FocusController.turnedOnByScreenFry
                            ? "Do Not Disturb is on: a Focus website is the tab in front."
                            : "A Focus website is the tab in front; Do Not Disturb was already on.")
                        : "Waiting for a Focus website to be the tab in front."
        }
        status.stringValue = FocusController.enabled && ready ? (controller.isOn ? "Beta · On" : "Beta · Ready") : "Beta"
    }

    @objc private func toggle(_ sender: NSButton) {
        controller.setEnabled(sender.state == .on)
    }

    @objc private func openShortcuts(_ sender: Any?) {
        if let url = URL(string: "shortcuts://create-shortcut"), NSWorkspace.shared.open(url) { return }
        if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.shortcuts") {
            NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    @objc private func checkAgain(_ sender: Any?) {
        controller.refreshInstalled()
        controller.evaluate()
    }
}
#endif
