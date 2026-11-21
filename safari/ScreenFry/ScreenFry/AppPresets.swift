import AppKit

/// The four presets, chosen in the Mac app for every browser at once. They're the same as the
/// browsers' own (packages/core/src/presets.ts, which tests/presets.test.ts keeps in step with
/// this list); the app sends only a preset's id and each browser builds it from its registry.
/// A fresh install offers them once, when the window first opens; an update never does.
enum AppPresets {
    struct Preset {
        let id: String
        let name: String
        let summary: String
        let points: [String]
    }

    static let all: [Preset] = [
        Preset(id: "popular", name: "Most popular", summary: "No feeds or Shorts, with an evening break.", points: [
            "Every feed hidden and Shorts, Reels and video feeds blocked, on every website.",
            "Fry Time from 6 pm to midnight: feeds come back for 30 minutes a day on each website.",
            "Search, links, profiles and messages keep working.",
        ]),
        Preset(id: "strict", name: "Strict mode", summary: "Every website blocked.", points: [
            "YouTube, Instagram, X, Reddit, Substack, TikTok, Facebook, LinkedIn and Quora are blocked all day.",
            "Turn one back on from its page whenever you need it.",
        ]),
        Preset(id: "chill", name: "Chill mode", summary: "One hour a day on each website.", points: [
            "A 1-hour daily limit on every website, reset at midnight.",
            "Feeds stay as they are; change any website’s controls later.",
        ]),
        Preset(id: "short-free", name: "Short-free", summary: "No Shorts, Reels or video feeds.", points: [
            "Shorts, Reels and endless video feeds blocked on every website, even from links.",
            "TikTok is blocked, since it’s all short videos.",
            "Everything else stays as it is.",
        ]),
    ]

    private static let offeredKey = "presetsOffered"
    /// Browser (raw value) → the preset id waiting for ScreenFry there to check in.
    private static let pendingKey = "pendingPresets"

    /// Whether to offer the presets now: once, on a fresh install. An existing install (an
    /// update from a version without them) is marked as offered instead.
    static func shouldOffer(existingInstall: Bool) -> Bool {
        let d = UserDefaults.standard
        if d.bool(forKey: offeredKey) { return false }
        if existingInstall {
            d.set(true, forKey: offeredKey)
            return false
        }
        return true
    }

    static func markOffered() { UserDefaults.standard.set(true, forKey: offeredKey) }

    private static var pendingByBrowser: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: pendingKey) as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: pendingKey) }
    }

    /// The preset waiting to go to a browser where ScreenFry hasn't checked in yet.
    static func pending(_ browser: SettingsBrowser) -> Preset? {
        pendingByBrowser[browser.rawValue].flatMap { id in all.first { $0.id == id } }
    }

    /// Uses a preset in every browser: right away where ScreenFry has checked in, and in the
    /// others as soon as it does (a fresh install chooses before the browsers are set up).
    static func choose(_ preset: Preset, for browsers: [SettingsBrowser]) {
        var pending = pendingByBrowser
        for browser in browsers { pending[browser.rawValue] = preset.id }
        pendingByBrowser = pending
        markOffered()
        deliver(to: browsers)
    }

    /// Hands each waiting preset to its browser once ScreenFry there has checked in (its
    /// bridge folder exists then; the app never creates Safari's container itself).
    static func deliver(to browsers: [SettingsBrowser]) {
        var pending = pendingByBrowser
        guard !pending.isEmpty else { return }
        for browser in browsers {
            guard let preset = Self.pending(browser), SettingsTransfer.checkIn(browser) != nil else { continue }
            if (try? SettingsTransfer.queueSetup(browser, preset: preset.id, name: preset.name)) != nil {
                pending[browser.rawValue] = nil
            }
        }
        pendingByBrowser = pending
    }

    /// Reset All Data and Uninstall forget presets still waiting.
    static func clearPending() { UserDefaults.standard.removeObject(forKey: pendingKey) }
}

/// The presets sheet over the main window: a short note on what presets are, the four
/// presets, and ✕ I'll choose my own settings.
final class PresetsSheet: NSObject {
    private let window: NSWindow
    private let browsers: [SettingsBrowser]
    private let first: Bool
    private let onChosen: () -> Void
    private let onSkipped: (_ first: Bool) -> Void
    private var sheet: NSWindow?
    private static var current: PresetsSheet?

    private static let ember = NSColor(srgbRed: 244 / 255, green: 98 / 255, blue: 31 / 255, alpha: 1)

    /// `first`: the one-time offer on a fresh install (skipping it says where to find them).
    static func show(over window: NSWindow, browsers: [SettingsBrowser], first: Bool,
                     onChosen: @escaping () -> Void, onSkipped: @escaping (_ first: Bool) -> Void) {
        guard current == nil, window.attachedSheet == nil else { return }
        let sheet = PresetsSheet(window: window, browsers: browsers, first: first, onChosen: onChosen, onSkipped: onSkipped)
        current = sheet
        sheet.present()
    }

    private init(window: NSWindow, browsers: [SettingsBrowser], first: Bool,
                 onChosen: @escaping () -> Void, onSkipped: @escaping (_ first: Bool) -> Void) {
        self.window = window
        self.browsers = browsers
        self.first = first
        self.onChosen = onChosen
        self.onSkipped = onSkipped
    }

    private var browserNames: String {
        browsers.map(\.name).joined(separator: " and ")
    }

    private func present() {
        let heading = NSTextField(labelWithString: "Start with a preset")
        heading.font = .systemFont(ofSize: 20, weight: .bold)
        let skip = NSButton(title: "✕  I’ll choose my own settings", target: self, action: #selector(skip(_:)))
        skip.bezelStyle = .rounded
        skip.keyEquivalent = "\u{1b}"
        skip.toolTip = "Close without a preset"
        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let top = NSStackView(views: [heading, spacer, skip])
        top.alignment = .centerY

        let intro = NSTextField(wrappingLabelWithString: "Presets are ready-made setups. Instead of going through every website yourself, pick the one closest to what you want and ScreenFry is set up in one click, in \(browserNames). You can change anything afterwards.")
        intro.font = .systemFont(ofSize: 13)
        intro.textColor = .secondaryLabelColor
        intro.preferredMaxLayoutWidth = 620

        let cards = AppPresets.all.enumerated().map { card($1, tag: $0) }
        let grid = NSGridView(views: [[cards[0], cards[1]], [cards[2], cards[3]]])
        grid.rowSpacing = 12
        grid.columnSpacing = 12
        grid.rowAlignment = .none
        for i in 0..<grid.numberOfRows { grid.row(at: i).yPlacement = .fill }
        for i in 0..<grid.numberOfColumns { grid.column(at: i).xPlacement = .fill }
        cards.forEach { $0.widthAnchor.constraint(equalToConstant: 304).isActive = true }

        let note = NSTextField(wrappingLabelWithString: "Each browser’s current setup is saved in an empty loadout there first. Today’s usage and settings passwords stay as they are.")
        note.font = .systemFont(ofSize: 11)
        note.textColor = .secondaryLabelColor
        note.preferredMaxLayoutWidth = 620

        let stack = NSStackView(views: [top, intro, grid, note])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        top.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
            stack.widthAnchor.constraint(equalToConstant: 620),
        ])
        let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 668, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        sheet.contentView = content
        sheet.setContentSize(content.fittingSize)
        self.sheet = sheet
        window.beginSheet(sheet)
    }

    private func card(_ preset: AppPresets.Preset, tag: Int) -> NSView {
        let name = NSTextField(labelWithString: preset.name)
        name.font = .systemFont(ofSize: 15, weight: .semibold)
        let summary = NSTextField(wrappingLabelWithString: preset.summary)
        summary.font = .systemFont(ofSize: 12, weight: .medium)
        summary.preferredMaxLayoutWidth = 272
        let points = NSTextField(wrappingLabelWithString: preset.points.map { "• \($0)" }.joined(separator: "\n"))
        points.font = .systemFont(ofSize: 11)
        points.textColor = .secondaryLabelColor
        points.preferredMaxLayoutWidth = 272
        let use = NSButton(title: "Use \(preset.name)", target: self, action: #selector(use(_:)))
        use.bezelStyle = .rounded
        use.bezelColor = Self.ember
        use.tag = tag
        let filler = NSView()
        filler.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .vertical)
        let stack = NSStackView(views: [name, summary, points, filler, use])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.setCustomSpacing(10, after: points)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let box = NSView()
        box.wantsLayer = true
        box.layer?.cornerRadius = 12
        box.layer?.borderWidth = 1
        box.layer?.borderColor = NSColor.separatorColor.cgColor
        box.layer?.backgroundColor = Self.ember.withAlphaComponent(0.06).cgColor
        box.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: box.topAnchor, constant: 14),
            stack.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -14),
        ])
        return box
    }

    @objc private func use(_ sender: NSButton) {
        let preset = AppPresets.all[sender.tag]
        let alert = NSAlert()
        alert.messageText = "Use \(preset.name) in \(browserNames)?"
        alert.informativeText = "Each browser switches to it the next time ScreenFry there checks in, within about a minute (a browser you haven’t set up yet gets it once ScreenFry is on there). Each browser’s current setup is saved in an empty loadout there first. A browser with a settings password asks for it there."
        alert.addButton(withTitle: "Use \(preset.name)")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: sheet!) { [self] answer in
            guard answer == .alertFirstButtonReturn else { return }
            AppPresets.choose(preset, for: browsers)
            finish()
            onChosen()
        }
    }

    @objc private func skip(_ sender: Any?) {
        AppPresets.markOffered()
        finish()
        onSkipped(first)
    }

    private func finish() {
        if let sheet { window.endSheet(sheet) }
        Self.current = nil
    }
}
