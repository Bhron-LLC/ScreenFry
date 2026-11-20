import AppKit

/// "ScreenFry updated to 1.0.4", with what's new, shown once after every update: by itself in
/// the background, from Sparkle's window, or by switching between stable and beta. The notes
/// are saved just before the update installs (the new copy can't know them otherwise).
enum UpdatedWindow {
    private static let versionKey = "updatedWindowVersion"
    private static let notesKey = "updatedWindowNotes"
    private static let betaKey = "updatedWindowBeta"
    private static var panel: NSPanel?

    static func remember(version: String, notes: String?, beta: Bool) {
        let d = UserDefaults.standard
        d.set(version, forKey: versionKey)
        d.set(notes, forKey: notesKey)
        d.set(beta, forKey: betaKey)
    }

    /// Shows the window. Quietly (after a background update) it appears in the corner without
    /// taking the focus from what you're doing.
    static func show(quietly: Bool) {
        let d = UserDefaults.standard
        let saved = d.string(forKey: versionKey)
        let notes = saved == AppVersion.display ? d.string(forKey: notesKey) : nil
        let beta = AppVersion.beta != nil
        [versionKey, notesKey, betaKey].forEach { d.removeObject(forKey: $0) }

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 300),
            styleMask: quietly ? [.titled, .closable, .nonactivatingPanel] : [.titled, .closable],
            backing: .buffered, defer: false)
        panel.title = "ScreenFry Updated"
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.level = .floating

        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.imageScaling = .scaleProportionallyUpOrDown
        NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: 48), icon.heightAnchor.constraint(equalToConstant: 48)])
        let heading = NSTextField(wrappingLabelWithString: "ScreenFry updated to \(AppVersion.display)")
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
        let kind = NSTextField(wrappingLabelWithString: beta
            ? (notes == nil ? "Beta update: experimental features that are still being built and may have bugs." : "Beta update")
            : notes == nil ? "See what's new in the changelog." : "Here's what's new:")
        kind.font = .systemFont(ofSize: 12)
        kind.textColor = beta ? NSColor(srgbRed: 0.957, green: 0.384, blue: 0.122, alpha: 1) : .secondaryLabelColor
        let titles = NSStackView(views: [heading, kind])
        titles.orientation = .vertical
        titles.alignment = .leading
        titles.spacing = 2
        let top = NSStackView(views: [icon, titles])
        top.alignment = .top
        top.spacing = 12

        var rows: [NSView] = [top]
        if let notes, let text = attributed(notes) {
            let view = NSTextView()
            view.isEditable = false
            view.drawsBackground = false
            view.textStorage?.setAttributedString(text)
            view.textContainerInset = NSSize(width: 0, height: 4)
            let scroll = NSScrollView()
            scroll.documentView = view
            scroll.hasVerticalScroller = true
            scroll.drawsBackground = false
            scroll.borderType = .noBorder
            view.autoresizingMask = [.width]
            view.frame = NSRect(x: 0, y: 0, width: 380, height: 10)
            view.sizeToFit()
            let height = min(220, max(60, (view.layoutManager?.usedRect(for: view.textContainer!).height ?? 60) + 12))
            scroll.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([scroll.heightAnchor.constraint(equalToConstant: height), scroll.widthAnchor.constraint(equalToConstant: 380)])
            rows.append(scroll)
        }
        let changes = NSButton(title: "See All Changes", target: Actions.shared, action: #selector(Actions.openChanges))
        changes.bezelStyle = .rounded
        let ok = NSButton(title: "OK", target: Actions.shared, action: #selector(Actions.close))
        ok.bezelStyle = .rounded
        ok.keyEquivalent = "\r"
        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let buttons = NSStackView(views: [spacer, changes, ok])
        rows.append(buttons)

        let stack = NSStackView(views: rows)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        buttons.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            stack.widthAnchor.constraint(equalToConstant: 380),
        ])
        panel.contentView = content
        panel.layoutIfNeeded()
        panel.setContentSize(content.fittingSize)
        // Top right of the screen, below the menu bar, where update notices usually appear.
        if let screen = NSScreen.main?.visibleFrame {
            panel.setFrameTopLeftPoint(NSPoint(x: screen.maxX - panel.frame.width - 16, y: screen.maxY - 12))
        }
        self.panel = panel
        if quietly {
            // A background update hid ScreenFry so it didn't take the focus; show just this.
            NSApp.unhideWithoutActivation()
            panel.orderFrontRegardless()
        } else {
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    /// The feed's HTML notes as text in the system font and colors (links kept).
    private static func attributed(_ html: String) -> NSAttributedString? {
        let page = "<style>body{font:13px -apple-system;line-height:1.4}ul{padding-left:18px;margin:0}li{margin-bottom:4px}p{margin:0 0 6px}</style>\(html)"
        guard let data = page.data(using: .utf8),
              let text = try? NSMutableAttributedString(
                data: data,
                options: [.documentType: NSAttributedString.DocumentType.html, .characterEncoding: String.Encoding.utf8.rawValue],
                documentAttributes: nil)
        else { return nil }
        let all = NSRange(location: 0, length: text.length)
        text.enumerateAttribute(.link, in: all) { link, range, _ in
            if link == nil { text.addAttribute(.foregroundColor, value: NSColor.labelColor, range: range) }
        }
        while text.string.hasSuffix("\n") { text.deleteCharacters(in: NSRange(location: text.length - 1, length: 1)) }
        return text
    }

    private final class Actions: NSObject {
        static let shared = Actions()
        @objc func openChanges() {
            NSWorkspace.shared.open(AppDelegate.changelogURL)
            close()
        }
        @objc func close() { UpdatedWindow.panel?.close() }
    }
}
