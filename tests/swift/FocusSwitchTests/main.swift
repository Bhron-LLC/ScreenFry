import Foundation

// Compiled with safari/ScreenFry/ScreenFry/FocusSwitch.swift and run by
// tests/focus-websites.test.ts (macOS only). Exits non-zero on the first failure.

var failures = 0
func expect(_ condition: Bool, _ what: String, line: Int = #line) {
    if !condition {
        failures += 1
        print("FAIL (line \(line)): \(what)")
    }
}

let t0 = Date(timeIntervalSince1970: 1_000_000)
func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

// Turning on is immediate, and asking again while on runs nothing.
do {
    var s = FocusSwitch()
    expect(s.update(wanted: true, now: at(0)).command == .turnOn, "on at once")
    expect(s.update(wanted: true, now: at(1)).command == nil, "no second On")
    expect(s.on, "remembers it's on")
}

// Leaving waits 10 seconds before turning off.
do {
    var s = FocusSwitch()
    _ = s.update(wanted: true, now: at(0))
    let left = s.update(wanted: false, now: at(5))
    expect(left.command == nil, "no Off straight away")
    expect(left.nextCheck == at(15), "looks again when the 10 seconds are up")
    expect(s.update(wanted: false, now: at(14.9)).command == nil, "still waiting just before")
    expect(s.update(wanted: false, now: at(15)).command == .turnOff, "off after 10 seconds")
    expect(!s.on, "remembers it's off")
    expect(s.update(wanted: false, now: at(30)).command == nil, "no second Off")
}

// Coming back within the 10 seconds keeps it on, and the next leave starts a fresh wait.
do {
    var s = FocusSwitch()
    _ = s.update(wanted: true, now: at(0))
    _ = s.update(wanted: false, now: at(1))
    expect(s.update(wanted: true, now: at(8)).command == nil, "back in time: no On, no Off")
    expect(s.offSince == nil, "the wait is cancelled")
    let again = s.update(wanted: false, now: at(9))
    expect(again.nextCheck == at(19), "a new 10 seconds from leaving again")
    expect(s.update(wanted: false, now: at(12)).command == nil, "the old wait no longer counts")
    expect(s.update(wanted: false, now: at(19)).command == .turnOff, "off 10 seconds after the last leave")
}

// Nothing wanted and nothing on: nothing to do.
do {
    var s = FocusSwitch()
    let r = s.update(wanted: false, now: at(0))
    expect(r.command == nil && r.nextCheck == nil, "idle")
    expect(s.stop() == nil, "stop does nothing when off")
}

// Switching the feature off or quitting turns it off without the wait.
do {
    var s = FocusSwitch()
    _ = s.update(wanted: true, now: at(0))
    expect(s.stop() == .turnOff, "stop turns off at once")
    expect(!s.on, "and remembers")
}

// A ScreenFry that quit with Do Not Disturb on turns it off after the wait when restarted.
do {
    var s = FocusSwitch(on: true)
    _ = s.update(wanted: false, now: at(0))
    expect(s.update(wanted: false, now: at(10)).command == .turnOff, "cleans up after a restart")
}

// Signals: only a running browser's recent "yes" counts.
do {
    let fresh = FocusSwitch.Signal(wanted: true, at: at(0), browserRunning: true)
    expect(FocusSwitch.wanted([fresh], now: at(60)), "a recent yes")
    expect(!FocusSwitch.wanted([fresh], now: at(180)), "a yes 3 minutes old has expired")
    expect(!FocusSwitch.wanted([FocusSwitch.Signal(wanted: true, at: at(0), browserRunning: false)], now: at(1)),
           "a browser that quit doesn't count")
    expect(!FocusSwitch.wanted([FocusSwitch.Signal(wanted: false, at: at(0), browserRunning: true)], now: at(1)), "a no")
    let other = FocusSwitch.Signal(wanted: false, at: at(50), browserRunning: true)
    expect(FocusSwitch.wanted([other, fresh], now: at(60)), "any browser's yes is enough")
    expect(FocusSwitch.nextExpiry([other, fresh], now: at(60)) == at(180), "looks again when the yes expires")
    expect(FocusSwitch.nextExpiry([other], now: at(60)) == nil, "no yes, nothing to expire")
}

if failures > 0 {
    print("\(failures) FocusSwitch test(s) failed")
    exit(1)
}
print("All FocusSwitch tests passed")
