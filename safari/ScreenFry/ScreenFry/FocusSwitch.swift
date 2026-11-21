import Foundation

/// Focus websites (beta, docs/FOCUS.md), the part that decides: given what the browsers say,
/// when to run the "ScreenFry Focus On" and "ScreenFry Focus Off" shortcuts. Foundation only,
/// so `tests/swift/FocusSwitchTests/main.swift` can run it without the app.
///
/// - Turning on is immediate: a browser says its tab in front is a Focus website.
/// - Turning off waits `grace` (10 seconds) of nobody wanting it. Wanting it again within
///   that time cancels the wait (switching tabs and coming back keeps it on).
/// - A browser's "yes" counts only while that browser is running and has said so recently
///   (`stale`): browsers repeat it with every check-in, about once a minute, so a browser
///   that quit or stopped answering can't keep Do Not Disturb on.
struct FocusSwitch: Equatable {
    static let grace: TimeInterval = 10
    static let stale: TimeInterval = 180

    enum Command: Equatable { case turnOn, turnOff }

    /// One browser's latest signal (`focus.json` in its bridge).
    struct Signal: Equatable {
        var wanted: Bool
        var at: Date
        var browserRunning: Bool
    }

    /// The On shortcut has run and the Off shortcut hasn't since.
    private(set) var on: Bool
    /// When nobody wanted it any more while it was on: the off wait started then.
    private(set) var offSince: Date?

    init(on: Bool = false) { self.on = on }

    /// Whether any browser wants Focus now.
    static func wanted(_ signals: [Signal], now: Date) -> Bool {
        signals.contains { live($0, now: now) }
    }

    private static func live(_ signal: Signal, now: Date) -> Bool {
        signal.wanted && signal.browserRunning && now.timeIntervalSince(signal.at) < stale
    }

    /// When a browser's "yes" goes stale, so the app looks again then.
    static func nextExpiry(_ signals: [Signal], now: Date) -> Date? {
        signals.filter { live($0, now: now) }.map { $0.at.addingTimeInterval(stale) }.min()
    }

    /// What to run now (if anything), and when to call again if nothing else changes.
    mutating func update(wanted: Bool, now: Date) -> (command: Command?, nextCheck: Date?) {
        if wanted {
            offSince = nil
            if on { return (nil, nil) }
            on = true
            return (.turnOn, nil)
        }
        guard on else {
            offSince = nil
            return (nil, nil)
        }
        let since = offSince ?? now
        if now.timeIntervalSince(since) >= Self.grace {
            on = false
            offSince = nil
            return (.turnOff, nil)
        }
        offSince = since
        return (nil, since.addingTimeInterval(Self.grace))
    }

    /// Off at once, without the wait: the setting was switched off, or the app is quitting.
    mutating func stop() -> Command? {
        offSince = nil
        guard on else { return nil }
        on = false
        return .turnOff
    }
}
