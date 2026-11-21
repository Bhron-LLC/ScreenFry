# Focus while browsing (beta)

While one of your Focus websites is the tab in front, the ScreenFry Mac app turns on **Do Not
Disturb**, and turns it off again 10 seconds after you leave. Built on `dev/next` for beta users
(docs/DISTRIBUTION.md, "Beta channel").

## Decided (Samir, November 21, 2026)

- **Do Not Disturb**, not a separate "ScreenFry" Focus. macOS has no public API to set a Focus,
  so the app runs two shortcuts the user adds once.
- **One list of websites you type**, in each browser's Settings → Focus while browsing. No site
  picker. Any website (`docs.google.com`, `notion.so`, `youtube.com`); subdomains and aliases
  count, as they do for windows and goals.
- **When it counts:** whenever a Focus website is the tab in front (the active tab of the
  browser's last focused window), whether or not the browser is the app in front, and whether
  or not you're idle. It turns off **10 seconds** after you switch away; coming back sooner
  resets that wait.

## How it works

1. **The extension** (`apps/extension/src/background/index.ts`, `updateFocus`) looks at the tab in
   front whenever tabs, windows or settings change. `focusWanted` in `packages/policy-engine`
   decides yes or no from `focusSites` (saved by `setFocusSites` in `packages/core`, behind the
   settings password like other edits). When the answer changes it sends
   `{type: "screenfry-focus", wanted}` by native messaging, and every check-in (about once a
   minute) repeats it as `focusWanted`. Only yes or no is sent, never the website.
2. **The bridge** (`safari/ScreenFry/Shared/SettingsBridge.swift`) writes it to `focus.json` in
   that browser's bridge folder: Chrome through the app's native messaging host, Safari through
   the extension's native handler (in its container).
3. **The Mac app** (`FocusController.swift`) watches both bridge folders. `FocusSwitch.swift`
   decides when to run the shortcuts:
   - **On** at once when any running browser says yes.
   - **Off** after 10 seconds of nobody saying yes (`FocusSwitch.grace`). A yes in between
     cancels it.
   - A yes counts only while that browser is running and for 3 minutes after it was last said
     (`FocusSwitch.stale`); check-ins refresh it every minute.
   - It turns Do Not Disturb off when the app quits (including to update) and when you untick
     the switch in its Focus card. It remembers across launches whether it turned it on, so a
     ScreenFry that quit unexpectedly still turns it off.
   - It only turns off a Do Not Disturb it turned on.

## The shortcuts

Make two shortcuts in the Shortcuts app, named exactly:

- **ScreenFry Focus On**: one action, *Set Focus* → *Do Not Disturb* → *Turn On* (until turned off).
- **ScreenFry Focus Off**: one action, *Set Focus* → *Do Not Disturb* → *Turn Off*.

The app's Focus card shows whether each exists (`shortcuts list`), and **New Shortcut** opens
Shortcuts. The app runs them with `/usr/bin/shortcuts run`.

**Keeping a Do Not Disturb you turned on yourself:** ScreenFry can't read whether a Focus is
already on. Start **ScreenFry Focus On** with *Get Current Focus*; *If* it has any value, *Stop
and Output* the text `already`; otherwise *Set Focus* on. When the On shortcut outputs
`already`, ScreenFry leaves Do Not Disturb alone when you leave.

## Where it runs

- The download versions of the Mac app (ScreenFry and ScreenFry Developer). The Mac App Store
  build (`APPSTORE`) compiles it out: its sandbox can't run `shortcuts`.
- Chrome and Safari, with the Mac app. Without the app nothing happens.

## Privacy

The list stays in the browser's storage. The browser tells the app only whether a Focus website
is in front. Time on Focus websites is not measured or recorded. Nothing leaves the Mac.

## Tests

- `tests/focus-websites.test.ts`: which addresses want Focus, the typed list, the password, and
  (on a Mac) the app's timing, compiling `FocusSwitch.swift` with
  `tests/swift/FocusSwitchTests/main.swift`.
- `tests/e2e/chrome-smoke.mjs`: a stand-in native messaging host checks that Chrome sends
  "wanted" on and off, and nothing else.

## Not done yet

- A one-click way to add the shortcuts (an iCloud link to each, made once in Shortcuts with
  Share → Copy iCloud Link) for the Focus card.
- Checking it live in Safari.
